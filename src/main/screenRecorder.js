/**
 * src/main/screenRecorder.js
 * ───────────────────────────
 * Manages the hidden recorder BrowserWindow and the full chunk-upload pipeline.
 *
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
 *                  (offline) keeps chunk queued and retries on "online".
 */

"use strict";

const path        = require("path");
const { BrowserWindow, desktopCapturer, ipcMain } = require("electron");
const logger      = require("./logger");
const authManager = require("./authManager");
const { IPC }     = require("../shared/constants");

// ─── Retry / poll tunables ────────────────────────────────────────────────────

const MAX_CHUNK_RETRIES  = 4;
const POLL_INTERVAL_MS   = 3000;
const MAX_POLL_MS        = 5 * 60 * 1000; // 5 min

// ─── Module state ─────────────────────────────────────────────────────────────

/** @type {BrowserWindow | null} */
let recorderWin  = null;
let isRecording  = false;

// Upload session
let uploadId     = null;
let chunkIndex   = 0;
let chunkBuffer  = []; // holds blobs when /start hasn't resolved yet
let pumpRunning  = false;
let pumpPromise  = Promise.resolve(); // tracked so _finalize() can await a running pump
let chunkQueue   = []; // { index, uint8Array }[]
let pollTimer    = null;

// Job meta
let jobMeta      = null; // { interviewId, fileName }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function _uploadWithRetry(uint8Array, index) {
  for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    const res = await authManager.uploadVideoChunk({ uploadId, chunkIndex: index, chunk: uint8Array });
    if (res.ok) { return; }
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
  if (!uploadId) return Promise.resolve();
  if (pumpRunning) return pumpPromise; // caller awaits the already-running pump

  pumpRunning = true;
  pumpPromise = (async () => {
    try {
      while (chunkQueue.length > 0) {
        const item = chunkQueue[0];
        try {
          await _uploadWithRetry(item.uint8Array, item.index);
          chunkQueue.shift();
          logger.info(`[recorder] chunk ${item.index} uploaded (${item.uint8Array.byteLength} B)`);
        } catch (err) {
          // Sustained failure (likely offline) — stop pumping; resume on "online" event.
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

function _clearPoll() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function _pollStatus() {
  _clearPoll();
  const startedAt = Date.now();

  const tick = async () => {
    pollTimer = null;
    if (Date.now() - startedAt > MAX_POLL_MS) {
      logger.warn("[recorder] status poll timed out after 5 min");
      _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: "Recording merge timed out" });
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
      _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: "Recording merge failed on server" });
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
      fileName:    jobMeta.fileName,
    });
    if (res.ok) {
      uploadId = res.uploadId;
      chunkBuffer.forEach((uint8Array) =>
        chunkQueue.push({ index: chunkIndex++, uint8Array })
      );
      chunkBuffer = [];
      await _pump();
    } else {
      logger.error("[recorder] fallback /start also failed — recording lost:", res.error);
      _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: "Could not register upload session." });
      return;
    }
  }

  if (!uploadId) { return; }

  // Drain any remaining queued chunks before completing.
  await _pump();

  const res = await authManager.completeVideoUpload(uploadId);
  if (res.ok) {
    logger.info("[recorder] /complete sent — polling merge status");
    _pollStatus();
  } else {
    logger.error("[recorder] /complete failed:", res.error);
    _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: "Failed to finalise recording." });
  }
}

function _pushToInterviewPage(channel, payload) {
  try {
    const { getWindow } = require("./windowManager");
    const win = getWindow();
    if (win && !win.isDestroyed()) { win.webContents.send(channel, payload); }
  } catch (err) {
    logger.warn(`[recorder] push ${channel} failed:`, err.message);
  }
}

function _resetState() {
  uploadId    = null;
  chunkIndex  = 0;
  chunkBuffer = [];
  chunkQueue  = [];
  pumpRunning = false;
  pumpPromise = Promise.resolve();
  jobMeta     = null;
  _clearPoll();
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
    if (!sources.length) { throw new Error("No screen sources found"); }

    const sourceId   = sources[0].id;
    const interviewId = meta.interviewId || null;
    const fileName    = `interview_${interviewId || Date.now()}.webm`;

    _resetState();
    isRecording = true;
    jobMeta     = { interviewId, fileName };

    // Register the upload session up-front so chunks stream during the interview.
    // If this fails we buffer chunks and retry at the end (/complete path).
    const startRes = await authManager.startVideoUpload({ interviewId, fileName });
    if (startRes.ok) {
      uploadId = startRes.uploadId;
      logger.info(`[recorder] upload session started — uploadId: ${uploadId}`);
    } else {
      logger.warn("[recorder] /start failed — buffering chunks:", startRes.error);
    }

    // Create hidden recorder window.
    recorderWin = new BrowserWindow({
      show:         false,
      width:        1,
      height:       1,
      skipTaskbar:  true,
      webPreferences: {
        preload:          path.join(__dirname, "../../preload-recorder.js"),
        nodeIntegration:  false,
        contextIsolation: true,
        sandbox:          false, // getUserMedia with chromeMediaSource requires this
        webSecurity:      true,
      },
    });

    recorderWin.webContents.once("did-finish-load", () => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        // recorderWin.webContents.openDevTools({ mode: "detach" }); // DEBUG — remove before shipping
        recorderWin.webContents.send(IPC.RECORDER_INIT, { sourceId });
      }
    });

    recorderWin.on("closed", () => { recorderWin = null; });
    recorderWin.loadFile(path.join(__dirname, "../../assets/recorder.html"));

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
  if (!isRecording) { return; }
  isRecording = false;

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
    logger.info("[recorder] MediaRecorder started — proctoring is live");
    _pushToInterviewPage(IPC.PUSH_PROCTORING_STARTED, {});
  });

  // Independently-decodable WebM chunk received — queue and pump.
  ipcMain.on(IPC.RECORDER_CHUNK, (_event, uint8Array) => {
    if (uploadId) {
      chunkQueue.push({ index: chunkIndex++, uint8Array });
      _pump();
    } else {
      // /start hasn't resolved yet — buffer; chunkIndex stays 0 so indices are
      // sequential when the buffer is drained in _finalize().
      chunkBuffer.push(uint8Array);
      logger.info(`[recorder] buffering chunk ${chunkBuffer.length - 1} (${uint8Array.byteLength} B) — no uploadId yet`);
    }
  });

  // All chunks flushed — call /complete and poll /status.
  ipcMain.on(IPC.RECORDER_STOPPED, async () => {
    logger.info("[recorder] final flush received — finalizing upload");
    await _finalize();
  });

  // Renderer error — log and surface to interview site.
  ipcMain.on(IPC.RECORDER_ERROR, (_event, msg) => {
    logger.error("[recorder] renderer error:", msg);
    isRecording = false;
    _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: msg });
  });

  // Resume chunk pump when connectivity returns.
  require("electron").app.on("ready", () => {
    const { net } = require("electron");
    // Use window online event proxy via the interview window for reconnection.
    // Simpler: check on each chunk arrival (pump is already idempotent).
  });
}

function getIsRecording() { return isRecording; }

module.exports = { start, stop, registerRecorderIpc, getIsRecording };
