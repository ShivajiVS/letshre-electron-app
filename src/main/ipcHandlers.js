/**
 * src/main/ipcHandlers.js
 * ───────────────────────
 * Centralised registration of ALL ipcMain channels.
 *
 * This is the only file that calls ipcMain.handle() or ipcMain.on().
 * Channel names come from shared/constants.js — no raw strings here.
 *
 * Call `registerIpcHandlers()` once during app initialisation.
 */

"use strict";

const path = require("path");
const { ipcMain } = require("electron");
const { app } = require("electron");
const logger = require("./logger");
const { IPC } = require("../shared/constants");
const { killSingleProcess, killAllProcesses } = require("./processKiller");
const { lockdownForInterview, getWindow } = require("./windowManager");
const { getCurrentInterviewUrl, getCurrentAccessToken } = require("./protocolHandler");
const startDetection = require("../detector/systemChecks");

/**
 * Registers all IPC handlers. Must be called after app is ready.
 */
function registerIpcHandlers() {
  // ── App Control ──────────────────────────────────────────────────────────

  ipcMain.on(IPC.QUIT_APP, () => {
    logger.info("[ipc] quit-app received");
    app.isQuiting = true;
    app.quit();
  });

  ipcMain.on(IPC.RECHECK_SYSTEM, () => {
    const win = getWindow();
    if (!win) {return;}
    logger.info("[ipc] recheck-system received");
    if (startDetection.resetState) {startDetection.resetState();}
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.RUN_PREFLIGHT, async () => {
    logger.info("[ipc] run-preflight-scans invoked");
    return await startDetection.runChecksOnce();
  });

  // ── Interview Flow ───────────────────────────────────────────────────────

  ipcMain.on(IPC.PROCEED_TO_INTERVIEW, () => {
    logger.info("[ipc] proceed-to-interview received");
    const interviewUrl = getCurrentInterviewUrl();
    const accessToken = getCurrentAccessToken();

    lockdownForInterview(interviewUrl);

    try {
      const win = getWindow();
      startDetection.start(win, accessToken);
    } catch (err) {
      logger.error("[ipc] detection start failed:", err.message);
    }
  });

  // ── Process Management ───────────────────────────────────────────────────

  ipcMain.handle(IPC.KILL_BLOCKED_APP, async (_event, processName) => {
    logger.info("[ipc] kill-blocked-app:", processName);
    return await killSingleProcess(processName);
  });

  ipcMain.handle(IPC.KILL_ALL_BLOCKED_APPS, async (_event, processNames) => {
    logger.info("[ipc] kill-all-blocked-apps:", processNames);
    return await killAllProcesses(processNames);
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
