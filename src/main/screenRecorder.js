/**
 * src/main/screenRecorder.js
 * ───────────────────────────
 * Manages the hidden recorder BrowserWindow lifecycle.
 *
 * Responsibilities:
 *   - Get screen source ID via desktopCapturer (main-process only API)
 *   - Spawn / destroy the hidden recorder window
 *   - Route "recorder:chunk" IPC events → authManager.uploadRecordingChunk()
 *   - Push PUSH_PROCTORING_STARTED / PUSH_PROCTORING_ERROR to the interview site
 *
 * Call registerRecorderIpc() once during app init (before any interview starts).
 * Call start(meta) / stop() from the ipcHandlers proctoring channels.
 */

"use strict";

const path = require("path");
const { BrowserWindow, desktopCapturer, ipcMain } = require("electron");
const logger = require("./logger");
const authManager = require("./authManager");
const { IPC } = require("../shared/constants");

/** @type {BrowserWindow | null} */
let recorderWin = null;

let chunkIndex = 0;
let sessionMeta = null; // { sessionId, interviewId }
let isRecording = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts screen + mic recording in a hidden BrowserWindow.
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
      thumbnailSize: { width: 0, height: 0 }, // skip thumbnail — saves memory
    });

    if (!sources.length) {
      throw new Error("No screen sources found");
    }

    const sourceId = sources[0].id; // primary display
    sessionMeta = { sessionId: meta.sessionId || null, interviewId: meta.interviewId || null };
    chunkIndex = 0;
    isRecording = true;

    recorderWin = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, "../../preload-recorder.js"),
        nodeIntegration: false,
        contextIsolation: true,
        // sandbox:false required — getUserMedia with chromeMediaSource needs
        // Electron's renderer IPC bridge which the Chrome sandbox restricts.
        sandbox: false,
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

    logger.info(`[recorder] hidden window created — sourceId: ${sourceId}`);
    return { ok: true };
  } catch (err) {
    isRecording = false;
    logger.error("[recorder] start failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Stops the active recording session.
 * Sends recorder:stop to the hidden window so MediaRecorder emits a final chunk,
 * then destroys the window after a short drain window.
 */
function stop() {
  if (!isRecording) { return; }
  isRecording = false;

  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(IPC.RECORDER_STOP);
    // Allow 3 s for the final chunk to arrive before destroying the window.
    setTimeout(() => {
      if (recorderWin && !recorderWin.isDestroyed()) {
        recorderWin.destroy();
        recorderWin = null;
      }
    }, 3000);
  }

  logger.info("[recorder] stop requested");
}

/**
 * Registers the internal IPC channels used by the hidden recorder window.
 * Must be called once during app initialisation (registerIpcHandlers).
 * These channels are NOT exposed through preload.js to the interview site.
 */
function registerRecorderIpc() {
  // Recorder confirmed MediaRecorder started — push to the interview page.
  ipcMain.on(IPC.RECORDER_READY, () => {
    logger.info("[recorder] MediaRecorder started — proctoring is live");
    _pushToInterviewPage(IPC.PUSH_PROCTORING_STARTED, {});
  });

  // Chunk received — upload to backend with token (never touches renderer).
  ipcMain.on(IPC.RECORDER_CHUNK, async (_event, uint8Array) => {
    const index = chunkIndex++;
    try {
      await authManager.uploadRecordingChunk(uint8Array, index, sessionMeta);
      logger.info(`[recorder] chunk ${index} uploaded (${uint8Array.byteLength} bytes)`);
    } catch (err) {
      logger.warn(`[recorder] chunk ${index} upload failed:`, err.message);
    }
  });

  // Recorder error — log and push to interview page.
  ipcMain.on(IPC.RECORDER_ERROR, (_event, msg) => {
    logger.error("[recorder] renderer error:", msg);
    isRecording = false;
    _pushToInterviewPage(IPC.PUSH_PROCTORING_ERROR, { error: msg });
  });
}

function getIsRecording() {
  return isRecording;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _pushToInterviewPage(channel, payload) {
  try {
    const { getWindow } = require("./windowManager");
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (err) {
    logger.warn(`[recorder] failed to push ${channel}:`, err.message);
  }
}

module.exports = { start, stop, registerRecorderIpc, getIsRecording };
