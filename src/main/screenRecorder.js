/**
 * Manages the hidden recorder BrowserWindow and the full chunk-upload pipeline.
 * Upload flow (mirrors ScreenRecordingContext.jsx / videoUpload.api.js):
 *   /start  → upload_id
 *   /chunk  × N  (sequential index, retry same index on failure)
 *   /complete  → 202 queued
 *   /status  poll until completed | failed | 5-min timeout
 *
 * Failure modes:
 *   /start fails → buffer chunks in memory; retry /start on recorder:stopped,
 *                  then drain the buffer before /complete.
 *   /chunk fails → exponential-backoff retry (4 attempts); sustained failure
 *                  pauses the pump and re-arms it on a timer, so a temporary
 *                  outage resumes on its own.
 *
 * Every chunk is mirrored to disk via pendingUploads before it is queued, and
 * /complete is sent ONLY once the queue is empty — a partial drain must never
 * be reported to the backend as a finished recording, or it merges a truncated
 * video and reports success. Anything left undrained is resumed on next launch.
 */

"use strict";

const path = require("path");
const { BrowserWindow, desktopCapturer, dialog, ipcMain } = require("electron");
const logger = require("./logger");
const authManager = require("./authManager");
const pendingUploads = require("./pendingUploads");
const { IPC, INTERVIEW_BASE_URL } = require("../shared/constants");

const MAX_CHUNK_RETRIES = 4;
const MAX_COMPLETE_RETRIES = 4;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 5 * 60 * 1000; // 5 min

// How long to wait before re-arming a pump that gave up after exhausting its
// per-chunk retries. Long enough not to hammer a down backend, short enough
// that a brief outage still drains within the same session.
const RESUME_RETRY_MS = 30000;

// Max ms to wait for the hidden recorder window to report RECORDER_READY after
// creation. If it never does (preload missing, getUserMedia blocked, renderer
// threw), the recording is dead — surface it instead of failing silently.
const READY_TIMEOUT_MS = 10000;

/** @type {BrowserWindow | null} */
let recorderWin = null;
let isRecording = false;

// Upload session
let uploadId = null;
let chunkIndex = 0;
let chunkBuffer = []; // holds blobs when /start hasn't resolved yet
let pumpRunning = false;
let pumpPromise = Promise.resolve(); // tracked so _finalize() can await a running pump
let chunkQueue = []; // { index, uint8Array }[]
let pollTimer = null;
let readyTimer = null; // watchdog: fires if RECORDER_READY never arrives
let resumeTimer = null; // re-arms a pump that exhausted its retries

// Identifies this recording's spill directory. Independent of uploadId, which
// may not exist yet when the first chunks land.
let sessionKey = null;

// Set once the recorder has been told to stop: a pump that drains *after* that
// point is responsible for sending /complete, since _finalize() has already
// come and gone.
let stopRequested = false;
let completeSent = false;

// Job meta
let jobMeta = null; // { interviewId, fileName }

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
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      logger.warn(`[recorder] chunk ${index} retry ${attempt} in ${backoff}ms — ${res.error}`);
      await sleep(backoff);
    } else {
      throw new Error(res.error || `chunk ${index} failed after ${MAX_CHUNK_RETRIES} attempts`);
    }
  }
}

function _pump() {
  if (!uploadId) {
    return Promise.resolve();
  }
  if (pumpRunning) {
    return pumpPromise;
  } // caller awaits the already-running pump

  pumpRunning = true;
  pumpPromise = (async () => {
    try {
      while (chunkQueue.length > 0) {
        const item = chunkQueue[0];
        try {
          await _uploadWithRetry(item.uint8Array, item.index);
          chunkQueue.shift();
          // Confirmed by the backend — the spill copy is no longer needed.
          if (sessionKey) {
            pendingUploads.removeChunk(sessionKey, item.index);
          }
          logger.info(`[recorder] chunk ${item.index} uploaded (${item.uint8Array.byteLength} B)`);
        } catch (err) {
          // Sustained failure (likely offline). The chunk stays queued and on
          // disk; _scheduleResume() re-arms rather than dropping it.
          logger.warn("[recorder] chunk pump paused:", err.message);
          break;
        }
      }
    } finally {
      pumpRunning = false;
    }
  })();

  return pumpPromise;
}

function _clearResumeTimer() {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
}

/**
 * Re-arms a paused pump. If the recorder has already stopped, a drain that
 * finally succeeds also has to send /complete — _finalize() ran while chunks
 * were still queued and deliberately declined to send it then.
 */
function _scheduleResume() {
  if (resumeTimer || !uploadId || chunkQueue.length === 0) {
    return;
  }
  resumeTimer = setTimeout(async () => {
    resumeTimer = null;
    logger.info(`[recorder] retrying upload — ${chunkQueue.length} chunk(s) still queued`);
    await _pump();
    if (chunkQueue.length > 0) {
      _scheduleResume();
    } else if (stopRequested) {
      await _completeIfDrained();
    }
  }, RESUME_RETRY_MS);
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
      return; // done
    }
    if (st === "failed") {
      logger.error("[recorder] backend merge failed");
      _notifyProctoringError("Recording merge failed on server");
      return;
    }
    // uploading | queued | processing → keep polling
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

async function _finalize() {
  // If /start never succeeded, retry it now with the buffered chunks.
  if (!uploadId && chunkBuffer.length > 0 && jobMeta?.interviewId) {
    logger.info("[recorder] /start was delayed — retrying with buffered chunks");
    const res = await authManager.startVideoUpload({
      interviewId: jobMeta.interviewId,
      fileName: jobMeta.fileName,
    });
    if (res.ok) {
      uploadId = res.uploadId;
      chunkBuffer.forEach((uint8Array) => chunkQueue.push({ index: chunkIndex++, uint8Array }));
      chunkBuffer = [];
      await _pump();
    } else {
      logger.error("[recorder] fallback /start also failed — recording lost:", res.error);
      _notifyProctoringError("Could not register upload session.");
      return;
    }
  }

  if (!uploadId) {
    return;
  }

  // Drain any remaining queued chunks before completing.
  await _pump();
  await _completeIfDrained();
}

/**
 * Sends /complete, but only when every chunk is confirmed uploaded.
 *
 * _pump() gives up after a chunk exhausts its retries, so reaching this point
 * does NOT imply the queue is empty. Completing anyway tells the backend to
 * merge whatever it has: it produces a truncated video AND reports
 * "completed", so the loss is invisible to the candidate, the interviewer and
 * these logs alike. Leaving the session on disk instead means the next launch
 * finishes the job.
 */
async function _completeIfDrained() {
  if (!uploadId) {
    return;
  }

  if (chunkQueue.length > 0) {
    logger.error(
      `[recorder] ${chunkQueue.length} chunk(s) still queued — withholding /complete to avoid a truncated merge; will resume`
    );
    _notifyProctoringError("Recording upload is incomplete — it will finish automatically.");
    _scheduleResume();
    return;
  }

  const res = await _completeWithRetry();
  if (res.ok) {
    completeSent = true;
    logger.info("[recorder] /complete sent — polling merge status");
    if (sessionKey) {
      pendingUploads.destroySession(sessionKey);
      sessionKey = null;
    }
    _pollStatus();
  } else {
    // Chunks are all uploaded but unmerged — the session stays on disk so the
    // next launch can retry /complete alone.
    logger.error("[recorder] /complete failed after retries:", res.error);
    _notifyProctoringError("Failed to finalise recording.");
  }
}

/**
 * Chunks already get four attempts each; /complete had none, so a single
 * transient failure stranded a fully-uploaded recording unmerged.
 */
async function _completeWithRetry(targetUploadId = null) {
  let last = { ok: false, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_COMPLETE_RETRIES; attempt++) {
    last = await authManager.completeVideoUpload(targetUploadId || uploadId);
    if (last.ok) {
      return last;
    }
    if (attempt < MAX_COMPLETE_RETRIES) {
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
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
 * The interview SPA owns the proctoring-error UX, but uploads outlive it: the
 * scorecard's "View Dashboard" navigates away while chunks are still draining,
 * and from then on PUSH_PROCTORING_ERROR reaches a page with no listener. Fall
 * back to a native dialog once the window has left the interview origin, so a
 * failed recording is never announced only to a page that stopped listening.
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
  uploadId = null;
  chunkIndex = 0;
  chunkBuffer = [];
  chunkQueue = [];
  pumpRunning = false;
  pumpPromise = Promise.resolve();
  jobMeta = null;
  sessionKey = null;
  stopRequested = false;
  completeSent = false;
  _clearPoll();
  _clearReadyWatchdog();
  _clearResumeTimer();
}

/**
 * Starts screen + mic recording in a hidden BrowserWindow.
 * Calls /start immediately to obtain an upload_id so chunks stream live.
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
    const interviewId = meta.interviewId || null;
    const fileName = `interview_${interviewId || Date.now()}.webm`;

    _resetState();
    isRecording = true;
    jobMeta = { interviewId, fileName };

    // Opened before /start so the spill directory exists for chunks that
    // arrive while /start is still in flight.
    sessionKey = `${interviewId || "unknown"}_${Date.now()}`;
    try {
      pendingUploads.createSession({ sessionKey, interviewId, fileName });
    } catch (err) {
      // Recording is still worth attempting without the safety net — losing
      // crash-recovery is much better than refusing to record at all.
      logger.error("[recorder] could not open spill directory:", err.message);
      sessionKey = null;
    }

    // Register the upload session up-front so chunks stream during the interview.
    // If this fails we buffer chunks and retry at the end (/complete path).
    const startRes = await authManager.startVideoUpload({ interviewId, fileName });
    if (startRes.ok) {
      uploadId = startRes.uploadId;
      if (sessionKey) {
        pendingUploads.setUploadId(sessionKey, uploadId);
      }
      logger.info(`[recorder] upload session started — uploadId: ${uploadId}`);
    } else {
      logger.warn("[recorder] /start failed — buffering chunks:", startRes.error);
    }

    recorderWin = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "../../preload-recorder.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // getUserMedia with chromeMediaSource requires this
        webSecurity: true,
      },
    });

    recorderWin.webContents.once("did-finish-load", () => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        recorderWin.webContents.send(IPC.RECORDER_INIT, { sourceId });
      }
    });

    recorderWin.on("closed", () => {
      recorderWin = null;
    });
    recorderWin.loadFile(path.join(__dirname, "../../assets/recorder.html"));

    // Watchdog: the recorder must report RECORDER_READY within READY_TIMEOUT_MS.
    // If it doesn't, the hidden window is dead (missing preload, blocked
    // getUserMedia, renderer threw) — no chunks will ever arrive and the
    // recording would be lost silently. Surface it to the interview page.
    _clearReadyWatchdog();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (!isRecording) {
        return;
      } // already stopped/cleaned up
      logger.error("[recorder] recorder never became ready — recording will not be captured");
      _notifyProctoringError("Screen recording could not start on this device.");
    }, READY_TIMEOUT_MS);

    logger.info(`[recorder] hidden window created — sourceId: ${sourceId}`);
    return { ok: true };
  } catch (err) {
    isRecording = false;
    _resetState();
    logger.error("[recorder] start failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Signals the recorder to stop. The recorder flushes the final WebM clusters,
 * sends recorder:stopped, then main calls /complete and polls /status.
 */
function stop() {
  if (!isRecording) {
    return;
  }
  isRecording = false;
  stopRequested = true;

  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(IPC.RECORDER_STOP);
    // Destroy window 5s after stop — enough time for onstop → flush → sendStopped.
    setTimeout(() => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        recorderWin.destroy();
        recorderWin = null;
      }
    }, 5000);
  }

  logger.info("[recorder] stop requested");
}

/**
 * Registers all internal IPC channels used between the hidden recorder window
 * and the main process. Call once during registerIpcHandlers().
 */
function registerRecorderIpc() {
  // MediaRecorder confirmed started.
  ipcMain.on(IPC.RECORDER_READY, () => {
    _clearReadyWatchdog();
    logger.info("[recorder] MediaRecorder started — proctoring is live");
    _pushToInterviewPage(IPC.PUSH_PROCTORING_STARTED, {});
  });

  // Independently-decodable WebM chunk received — spill to disk, queue, pump.
  ipcMain.on(IPC.RECORDER_CHUNK, (_event, uint8Array) => {
    // Both branches below assign the same index the chunk will carry when
    // uploaded, so the spill copy is addressable either way: chunkIndex only
    // advances once uploadId exists, and chunkBuffer is only used before it
    // does, so the two counters can never disagree.
    const index = uploadId ? chunkIndex : chunkBuffer.length;
    if (sessionKey) {
      try {
        pendingUploads.saveChunk(sessionKey, index, uint8Array);
      } catch (err) {
        logger.error(`[recorder] could not spill chunk ${index} to disk:`, err.message);
      }
    }

    if (uploadId) {
      chunkQueue.push({ index: chunkIndex++, uint8Array });
      _pump();
    } else {
      // /start hasn't resolved yet — buffer; chunkIndex stays 0 so indices are
      // sequential when the buffer is drained in _finalize().
      chunkBuffer.push(uint8Array);
      logger.info(
        `[recorder] buffering chunk ${chunkBuffer.length - 1} (${uint8Array.byteLength} B) — no uploadId yet`
      );
    }
  });

  // All chunks flushed — call /complete and poll /status.
  ipcMain.on(IPC.RECORDER_STOPPED, async () => {
    logger.info("[recorder] final flush received — finalizing upload");
    await _finalize();
  });

  // Renderer error — log and surface to interview site.
  ipcMain.on(IPC.RECORDER_ERROR, (_event, msg) => {
    _clearReadyWatchdog();
    logger.error("[recorder] renderer error:", msg);
    isRecording = false;
    _notifyProctoringError(msg);
  });
}

/**
 * Whether quitting right now would leave the recording unfinished. Scoped to
 * the post-stop drain window: during a live interview the recording is still
 * being produced, and blocking quit there would trap the candidate.
 */
function hasPendingUpload() {
  if (!stopRequested || completeSent) {
    return false;
  }
  return chunkQueue.length > 0 || chunkBuffer.length > 0 || Boolean(uploadId);
}

function getPendingChunkCount() {
  return chunkQueue.length + chunkBuffer.length;
}

/**
 * Resolves once the drain finishes, or false if it is still going after
 * `timeoutMs` — the caller decides what to do rather than blocking quit
 * indefinitely on a backend that may never answer.
 */
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
 * Finishes uploads left behind by a previous run — the app quitting, crashing
 * or losing power between the last confirmed chunk and /complete used to lose
 * the recording outright. Call once at startup, after auth is restored (every
 * request here needs a valid token).
 *
 * Best-effort by design: a session that still cannot be drained is left on
 * disk for the launch after this one, until it ages out of pendingUploads.
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

/**
 * @returns {Promise<boolean>} true when the session reached /complete and its
 * spill directory was removed.
 */
async function _resumeSession(session) {
  const { sessionKey: key, interviewId, fileName, chunkIndices } = session;
  let targetUploadId = session.uploadId;

  // /start never succeeded last run, so the backend has no session to attach
  // these chunks to — register one now. Without an interviewId there is
  // nothing to attach them to at all and they can only be discarded.
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
      // Same rule as the live path: a partial drain must not be completed.
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
};
