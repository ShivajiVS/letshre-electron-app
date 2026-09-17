/**
 * Hidden recorder window plus the chunk upload pipeline:
 *   /start → upload_id, /chunk × N while recording, /complete, then /status polling.
 *
 * Every chunk is spilled to disk before it is queued and removed only once the
 * backend confirms it. /complete is never sent while anything is still queued:
 * the backend would merge a truncated video and report success. Whatever is
 * left undrained is resumed on the next launch.
 */

"use strict";

const path = require("path");
const { BrowserWindow, desktopCapturer, dialog, ipcMain, net } = require("electron");
const logger = require("./logger");
const authManager = require("./authManager");
const pendingUploads = require("./pendingUploads");
const { createBitrateController } = require("./adaptiveBitrate");
const { IPC, INTERVIEW_BASE_URL } = require("../shared/constants");

const MAX_CHUNK_RETRIES = 4;
const MAX_COMPLETE_RETRIES = 4;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 5 * 60 * 1000;

// Chunks are independently decodable and the backend merges them by index, so
// they do not have to arrive in order.
const MAX_PARALLEL_UPLOADS = 2;

// ~2 MB each. Past this, queued payloads are dropped and re-read from disk.
const MAX_IN_MEMORY_CHUNKS = 4;

// About five minutes behind at 15 s per chunk.
const BACKLOG_ALERT_CHUNKS = 20;

const READY_TIMEOUT_MS = 10000;

// Mutable only through the test seam — an env knob would let a candidate
// stretch these until uploads never finish.
let retryBaseMs = 1000;
let retryCapMs = 8000;
let retryAfterMs = 30000;
let connectivityPollMs = 2000;
let isOnline = () => net.isOnline();

/** @type {BrowserWindow | null} */
let recorderWin = null;
let isRecording = false;

let uploadId = null;
let chunkIndex = 0;
let chunkQueue = []; // { index, uint8Array: Uint8Array | null, inFlight }
let pumpRunning = false;
let pumpPromise = Promise.resolve();
let startPromise = null;
let completePromise = null;
let pollTimer = null;
let readyTimer = null;
let retryTimer = null;
let backlogReported = false;
let bitrate = createBitrateController();
let sessionKey = null;
let stopRequested = false;
let completeSent = false;
let jobMeta = null; // { interviewId, fileName }

// Bumped on every reset so a request from a previous session cannot write into this one.
let generation = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _uploadWithRetry(uint8Array, index, targetUploadId = null) {
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    const res = await authManager.uploadVideoChunk({
      uploadId: targetUploadId || uploadId,
      chunkIndex: index,
      chunk: uint8Array,
    });
    if (res.ok) {
      return;
    }
    if (attempt < MAX_CHUNK_RETRIES) {
      const backoff = Math.min(retryBaseMs * 2 ** attempt, retryCapMs);
      logger.warn(`[recorder] chunk ${index} retry ${attempt} in ${backoff}ms — ${res.error}`);
      await sleep(backoff);
    } else {
      throw new Error(res.error || `chunk ${index} failed after ${MAX_CHUNK_RETRIES} attempts`);
    }
  }
}

/** Resolves true once an upload session exists. Retried by the caller, not here. */
function _registerUpload() {
  if (uploadId) {
    return Promise.resolve(true);
  }
  if (startPromise) {
    return startPromise;
  }

  const gen = generation;
  startPromise = (async () => {
    try {
      const res = await authManager.startVideoUpload(jobMeta);
      if (gen !== generation) {
        return false;
      }
      if (!res.ok) {
        logger.warn("[recorder] /start failed — chunks stay queued:", res.error);
        return false;
      }
      uploadId = res.uploadId;
      logger.info(`[recorder] upload session started — uploadId: ${uploadId}`);
      if (sessionKey) {
        try {
          pendingUploads.setUploadId(sessionKey, uploadId);
        } catch (err) {
          logger.error("[recorder] could not record uploadId on disk:", err.message);
        }
      }
      return true;
    } finally {
      if (gen === generation) {
        startPromise = null;
      }
    }
  })();
  return startPromise;
}

function _pump() {
  if (!uploadId) {
    return Promise.resolve();
  }
  if (pumpRunning) {
    return pumpPromise;
  }

  pumpRunning = true;
  const queue = chunkQueue;
  const key = sessionKey;
  const id = uploadId;
  let failed = false;

  const worker = async () => {
    while (!failed) {
      const item = queue.find((c) => !c.inFlight);
      if (!item) {
        return;
      }
      item.inFlight = true;
      try {
        const payload = item.uint8Array || pendingUploads.readChunk(key, item.index);
        await _uploadWithRetry(payload, item.index, id);
        queue.splice(queue.indexOf(item), 1);
        if (key) {
          pendingUploads.removeChunk(key, item.index);
        }
        logger.info(`[recorder] chunk ${item.index} uploaded (${payload.byteLength} B)`);
      } catch (err) {
        // Likely offline. The chunk stays queued and on disk for the retry.
        item.inFlight = false;
        failed = true;
        logger.warn(`[recorder] chunk pump paused at chunk ${item.index}:`, err.message);
      }
    }
  };

  pumpPromise = Promise.all(Array.from({ length: MAX_PARALLEL_UPLOADS }, () => worker())).finally(
    () => {
      pumpRunning = false;
    }
  );
  return pumpPromise;
}

/**
 * Registers the upload if needed, uploads what is queued, and completes once
 * the recording has stopped and nothing is left. Anything that cannot go now
 * is handed to the retry timer.
 */
async function _drain() {
  if (chunkQueue.length > 0) {
    if (!isOnline() || !(await _registerUpload())) {
      _scheduleRetry();
      return;
    }
    await _pump();
  }

  if (chunkQueue.length > 0) {
    _scheduleRetry();
    return;
  }
  if (stopRequested) {
    await _completeIfDrained();
  }
}

function _clearRetryTimer() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * Retries after retryAfterMs, or as soon as the connection comes back if it
 * dropped in the meantime — a short outage should not cost the full wait.
 */
function _scheduleRetry() {
  if (retryTimer) {
    return;
  }
  const dueAt = Date.now() + retryAfterMs;
  let wentOffline = !isOnline();

  retryTimer = setInterval(
    () => {
      if (!isOnline()) {
        wentOffline = true;
        return;
      }
      if (!wentOffline && Date.now() < dueAt) {
        return;
      }
      _clearRetryTimer();
      logger.info(`[recorder] retrying upload — ${chunkQueue.length} chunk(s) queued`);
      _drain().catch((err) => logger.error("[recorder] upload retry failed:", err.message));
    },
    Math.min(connectivityPollMs, retryAfterMs)
  );
}

function _reportBacklog() {
  if (backlogReported || chunkQueue.length < BACKLOG_ALERT_CHUNKS) {
    return;
  }
  backlogReported = true;
  _notifyProctoringError(`Recording upload is ${chunkQueue.length} chunks behind`);
}

/** Only while uploads are flowing: during an outage a lower bitrate would not help. */
function _adaptBitrate() {
  if (!isRecording || !uploadId || retryTimer) {
    return;
  }
  const bps = bitrate.observe(chunkQueue.length);
  if (bps === null) {
    return;
  }
  logger.info(
    `[recorder] upload backlog ${chunkQueue.length} — video bitrate now ${bps / 1000} kbps`
  );
  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(IPC.RECORDER_SET_BITRATE, bps);
  }
}

function _clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function _clearReadyWatchdog() {
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

function _pollStatus() {
  _clearPoll();
  const startedAt = Date.now();

  const tick = async () => {
    pollTimer = null;
    if (Date.now() - startedAt > MAX_POLL_MS) {
      logger.warn("[recorder] status poll timed out after 5 min");
      _notifyProctoringError("Recording merge timed out");
      return;
    }
    const res = await authManager.getVideoUploadStatus(uploadId);
    if (!res.ok) {
      logger.warn("[recorder] status poll error:", res.error);
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    const st = res.status;
    logger.info(`[recorder] merge status: ${st}`);
    if (st === "completed") {
      logger.info("[recorder] recording merged successfully", res.videoUrl || "");
      return;
    }
    if (st === "failed") {
      logger.error("[recorder] backend merge failed");
      _notifyProctoringError("Recording merge failed on server");
      return;
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function _finalize() {
  await _drain();
  if (!completeSent && chunkQueue.length > 0) {
    _notifyProctoringError("Recording upload is incomplete — it will finish automatically.");
  }
}

/** Sends /complete, but only when every chunk is confirmed uploaded. */
async function _completeIfDrained() {
  if (!uploadId || completeSent) {
    return;
  }

  if (chunkQueue.length > 0) {
    logger.error(
      `[recorder] ${chunkQueue.length} chunk(s) still queued — withholding /complete to avoid a truncated merge`
    );
    _scheduleRetry();
    return;
  }

  if (completePromise) {
    await completePromise;
    return;
  }

  completePromise = _completeWithRetry();
  const res = await completePromise;
  if (res.ok) {
    completeSent = true;
    logger.info("[recorder] /complete sent — polling merge status");
    if (sessionKey) {
      pendingUploads.destroySession(sessionKey);
      sessionKey = null;
    }
    _pollStatus();
  } else {
    // Every chunk is uploaded; the session stays on disk so the next launch retries /complete.
    completePromise = null;
    logger.error("[recorder] /complete failed after retries:", res.error);
    _notifyProctoringError("Failed to finalise recording.");
  }
}

async function _completeWithRetry(targetUploadId = null) {
  let last = { ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_COMPLETE_RETRIES; attempt++) {
    last = await authManager.completeVideoUpload(targetUploadId || uploadId);
    if (last.ok) {
      return last;
    }
    if (attempt < MAX_COMPLETE_RETRIES) {
      const backoff = Math.min(retryBaseMs * 2 ** attempt, retryCapMs);
      logger.warn(`[recorder] /complete retry ${attempt} in ${backoff}ms — ${last.error}`);
      await sleep(backoff);
    }
  }
  return last;
}

function _pushToInterviewPage(channel, payload) {
  try {
    const { getWindow } = require("./windowManager");
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (err) {
    logger.warn(`[recorder] push ${channel} failed:`, err.message);
  }
}

/**
 * Uploads outlive the interview page — the scorecard navigates away while
 * chunks are still draining — so once the window has left the interview origin
 * the error goes to a native dialog instead of a page with no listener.
 */
function _notifyProctoringError(message) {
  let onInterviewPage = false;
  try {
    const { getWindow } = require("./windowManager");
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      onInterviewPage = win.webContents.getURL().startsWith(INTERVIEW_BASE_URL);
    }
  } catch (err) {
    logger.warn("[recorder] could not resolve current page:", err.message);
  }

  if (onInterviewPage) {
    _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: message });
    return;
  }

  dialog
    .showMessageBox({
      type: "warning",
      buttons: ["OK"],
      title: "Interview recording",
      message,
    })
    .catch((err) => logger.warn("[recorder] error dialog failed:", err.message));
}

function _resetState() {
  generation++;
  isRecording = false;
  uploadId = null;
  chunkIndex = 0;
  chunkQueue = [];
  backlogReported = false;
  bitrate = createBitrateController();
  pumpRunning = false;
  pumpPromise = Promise.resolve();
  startPromise = null;
  completePromise = null;
  jobMeta = null;
  sessionKey = null;
  stopRequested = false;
  completeSent = false;
  _clearPoll();
  _clearReadyWatchdog();
  _clearRetryTimer();
}

function _openSession({ interviewId = null } = {}) {
  _resetState();
  isRecording = true;
  jobMeta = { interviewId, fileName: `interview_${interviewId || Date.now()}.webm` };

  sessionKey = `${interviewId || "unknown"}_${Date.now()}`;
  try {
    pendingUploads.createSession({ sessionKey, interviewId, fileName: jobMeta.fileName });
  } catch (err) {
    // Recording without crash recovery beats not recording at all.
    logger.error("[recorder] could not open spill directory:", err.message);
    sessionKey = null;
  }
}

function _onChunk(uint8Array) {
  const index = chunkIndex++;
  let saved = false;
  if (sessionKey) {
    try {
      pendingUploads.saveChunk(sessionKey, index, uint8Array);
      saved = true;
    } catch (err) {
      logger.error(`[recorder] could not spill chunk ${index} to disk:`, err.message);
    }
  }

  // The payload can only be dropped when a spill copy exists to read it back from.
  const spilled = saved && chunkQueue.length >= MAX_IN_MEMORY_CHUNKS;
  chunkQueue.push({ index, uint8Array: spilled ? null : uint8Array, inFlight: false });
  _reportBacklog();
  _adaptBitrate();
  _drain().catch((err) => logger.error("[recorder] upload drain failed:", err.message));
}

/**
 * Starts screen + mic recording in a hidden BrowserWindow. The upload session
 * is registered in the background so chunks stream during the interview.
 * @param {{ sessionId?: string, interviewId?: string }} meta
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function start(meta = {}) {
  if (isRecording) {
    logger.warn("[recorder] start called while already recording — ignoring");
    return { ok: false, error: "Already recording" };
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (!sources.length) {
      throw new Error("No screen sources found");
    }
    const sourceId = sources[0].id;

    _openSession(meta);
    _registerUpload().catch((err) => logger.error("[recorder] /start threw:", err.message));

    recorderWin = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "../../preload-recorder.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // chromeMediaSource capture needs it
        webSecurity: true,
      },
    });

    recorderWin.webContents.once("did-finish-load", () => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        recorderWin.webContents.send(IPC.RECORDER_INIT, {
          sourceId,
          videoBitsPerSecond: bitrate.bitsPerSecond,
        });
      }
    });

    recorderWin.on("closed", () => {
      recorderWin = null;
    });
    recorderWin.loadFile(path.join(__dirname, "../../assets/recorder.html"));

    // A recorder that never reports ready (missing preload, blocked capture)
    // would otherwise lose the recording without a word.
    _clearReadyWatchdog();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!isRecording) {
        return;
      }
      logger.error("[recorder] recorder never became ready — recording will not be captured");
      _notifyProctoringError("Screen recording could not start on this device.");
    }, READY_TIMEOUT_MS);

    logger.info(`[recorder] hidden window created — sourceId: ${sourceId}`);
    return { ok: true };
  } catch (err) {
    _resetState();
    logger.error("[recorder] start failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/** The recorder flushes its last chunk, then sends RECORDER_STOPPED to finalize. */
function stop() {
  if (!isRecording) {
    return;
  }
  isRecording = false;
  stopRequested = true;

  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(IPC.RECORDER_STOP);
    // Enough time for the final flush to reach main.
    setTimeout(() => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        recorderWin.destroy();
        recorderWin = null;
      }
    }, 5000);
  }

  logger.info("[recorder] stop requested");
}

function registerRecorderIpc() {
  ipcMain.on(IPC.RECORDER_READY, () => {
    _clearReadyWatchdog();
    logger.info("[recorder] MediaRecorder started — proctoring is live");
    _pushToInterviewPage(IPC.PUSH_PROCTORING_STARTED, {});
  });

  ipcMain.on(IPC.RECORDER_CHUNK, (_event, uint8Array) => _onChunk(uint8Array));

  ipcMain.on(IPC.RECORDER_STOPPED, () => {
    logger.info("[recorder] final flush received — finalizing upload");
    _finalize().catch((err) => logger.error("[recorder] finalize failed:", err.message));
  });

  ipcMain.on(IPC.RECORDER_ERROR, (_event, msg) => {
    _clearReadyWatchdog();
    logger.error("[recorder] renderer error:", msg);
    isRecording = false;
    _notifyProctoringError(msg);
  });
}

/**
 * Whether quitting now would leave the recording unfinished. Only after stop:
 * blocking quit during a live interview would trap the candidate.
 */
function hasPendingUpload() {
  if (!stopRequested || completeSent) {
    return false;
  }
  return chunkQueue.length > 0 || Boolean(uploadId);
}

function getPendingChunkCount() {
  return chunkQueue.length;
}

/** Resolves true once drained, or false if still going after `timeoutMs`. */
function whenDrained(timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (!hasPendingUpload()) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Finishes uploads left behind by a quit, crash or power loss. Call once at
 * startup after auth is restored. A session that still cannot be drained stays
 * on disk for the next launch until it ages out.
 */
async function resumePendingUploads() {
  if (isRecording) {
    logger.warn("[recorder] resume skipped — a recording is active");
    return { resumed: 0, failed: 0 };
  }

  let sessions;
  try {
    sessions = pendingUploads.listPending();
  } catch (err) {
    logger.error("[recorder] could not scan pending uploads:", err.message);
    return { resumed: 0, failed: 0 };
  }

  if (sessions.length === 0) {
    return { resumed: 0, failed: 0 };
  }

  logger.info(`[recorder] ${sessions.length} interrupted upload(s) found — resuming`);

  let resumed = 0;
  let failed = 0;
  for (const session of sessions) {
    if (await _resumeSession(session)) {
      resumed++;
    } else {
      failed++;
    }
  }

  logger.info(`[recorder] resume finished — ${resumed} completed, ${failed} still pending`);
  return { resumed, failed };
}

/** @returns {Promise<boolean>} true when the session completed and was removed. */
async function _resumeSession(session) {
  const { sessionKey: key, interviewId, fileName, chunkIndices } = session;
  let targetUploadId = session.uploadId;

  if (!targetUploadId) {
    if (!interviewId) {
      logger.warn(`[recorder] resume: session ${key} has no uploadId or interviewId — discarding`);
      pendingUploads.destroySession(key);
      return false;
    }
    const res = await authManager.startVideoUpload({ interviewId, fileName });
    if (!res.ok) {
      logger.warn(`[recorder] resume: /start failed for ${key} — ${res.error}`);
      return false;
    }
    targetUploadId = res.uploadId;
    pendingUploads.setUploadId(key, targetUploadId);
  }

  for (const index of chunkIndices) {
    let bytes;
    try {
      bytes = pendingUploads.readChunk(key, index);
    } catch (err) {
      logger.error(`[recorder] resume: chunk ${index} of ${key} unreadable — ${err.message}`);
      return false;
    }
    try {
      await _uploadWithRetry(bytes, index, targetUploadId);
      pendingUploads.removeChunk(key, index);
      logger.info(`[recorder] resume: chunk ${index} uploaded (${bytes.byteLength} B)`);
    } catch (err) {
      // A partial drain must not be completed.
      logger.warn(`[recorder] resume: chunk ${index} of ${key} failed — ${err.message}`);
      return false;
    }
  }

  const res = await _completeWithRetry(targetUploadId);
  if (!res.ok) {
    logger.error(`[recorder] resume: /complete failed for ${key} — ${res.error}`);
    return false;
  }

  logger.info(`[recorder] resume: ${key} completed`);
  pendingUploads.destroySession(key);
  return true;
}

module.exports = {
  start,
  stop,
  registerRecorderIpc,
  resumePendingUploads,
  hasPendingUpload,
  getPendingChunkCount,
  whenDrained,

  // Drives the live pipeline without an Electron window, and without real backoff.
  _testSeam: {
    configure(opts) {
      retryBaseMs = opts.retryBaseMs ?? retryBaseMs;
      retryCapMs = opts.retryCapMs ?? retryCapMs;
      retryAfterMs = opts.retryAfterMs ?? retryAfterMs;
      connectivityPollMs = opts.connectivityPollMs ?? connectivityPollMs;
      isOnline = opts.isOnline ?? isOnline;
    },
    openSession: _openSession,
    onChunk: _onChunk,
    finalize: _finalize,
    reset: _resetState,
  },
};
