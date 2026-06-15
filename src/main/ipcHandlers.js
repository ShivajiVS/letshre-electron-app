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
const { ipcMain, app } = require("electron");
const { autoUpdater } = require("electron-updater");
const logger = require("./logger");
const appState = require("./appState");
const { IPC } = require("../shared/constants");
const { killSingleProcess, killAllProcesses } = require("./processKiller");
const { lockdownForInterview, getWindow } = require("./windowManager");
const { getCurrentInterviewUrl, getCurrentAccessToken } = require("./protocolHandler");
const startDetection = require("../detector/systemChecks");

// ─── Input validation ─────────────────────────────────────────────────────────

/**
 * Validates and sanitises a process name coming from the renderer.
 * IMP-03: Prevents type confusion and oversized payloads from reaching processKiller.
 * @param {unknown} value
 * @returns {{ valid: boolean, safe: string }}
 */
function validateProcessName(value) {
  if (typeof value !== "string") {
    return { valid: false, safe: "" };
  }
  if (value.length === 0 || value.length > 120) {
    return { valid: false, safe: "" };
  }
  // Strip anything that isn't alphanumeric, dot, dash, space, or underscore
  const safe = value.replace(/[^\w.\- ]/g, "");
  return { valid: safe.length > 0, safe };
}

// ─── Handler Registration ─────────────────────────────────────────────────────

/**
 * Registers all IPC handlers. Must be called after app is ready.
 */
function registerIpcHandlers() {
  // ── App Control ──────────────────────────────────────────────────────────

  ipcMain.on(IPC.QUIT_APP, () => {
    logger.info("[ipc] quit-app received");
    appState.setQuitting();
    app.quit();
  });

  ipcMain.on(IPC.RECHECK_SYSTEM, () => {
    const win = getWindow();
    if (!win) { return; }
    logger.info("[ipc] recheck-system received");
    if (startDetection.resetState) { startDetection.resetState(); }
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.RUN_PREFLIGHT, async (event) => {
    logger.info("[ipc] run-preflight-scans invoked");

    // ADD-02: Streaming preflight — push progress for each step as it completes.
    // event.sender.send() is safe to call from within an ipcMain.handle() handler.
    const onProgress = (step, status, result) => {
      try {
        event.sender.send(IPC.PREFLIGHT_PROGRESS, { step, status, result });
      } catch {
        // Renderer was destroyed before the scan finished — ignore
      }
    };

    return await startDetection.runChecksOnce(onProgress);
  });

  // ── Interview Flow ───────────────────────────────────────────────────────

  ipcMain.on(IPC.PROCEED_TO_INTERVIEW, () => {
    logger.info("[ipc] proceed-to-interview received");
    const interviewUrl = getCurrentInterviewUrl();
    const accessToken  = getCurrentAccessToken();

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
    // IMP-03: Validate and sanitise before passing to processKiller
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app rejected — invalid processName:", processName);
      return { success: false, error: "Invalid process name", processName: String(processName).slice(0, 40) };
    }
    logger.info("[ipc] kill-blocked-app:", safe);
    return await killSingleProcess(safe);
  });

  ipcMain.handle(IPC.KILL_ALL_BLOCKED_APPS, async (_event, processNames) => {
    // IMP-03: Validate array input
    if (!Array.isArray(processNames)) {
      logger.warn("[ipc] kill-all-blocked-apps rejected — not an array");
      return [];
    }
    const validNames = processNames
      .map((n) => validateProcessName(n))
      .filter((r) => r.valid)
      .map((r) => r.safe);

    logger.info("[ipc] kill-all-blocked-apps:", validNames);
    return await killAllProcesses(validNames);
  });

  // ── Auto-Updater ─────────────────────────────────────────────────────────
  // ADD-01: Renderer can trigger install after update-downloaded event.

  ipcMain.on(IPC.INSTALL_UPDATE, () => {
    logger.info("[ipc] install-update received — quitting and installing");
    appState.setQuitting();
    autoUpdater.quitAndInstall();
  });

  // ── Audit Trail ──────────────────────────────────────────────────────────
  // ADD-07: Exposes the in-memory audit log to the renderer (support diagnostics).

  ipcMain.handle(IPC.GET_AUDIT_LOG, () => {
    return startDetection.getAuditLog ? startDetection.getAuditLog() : [];
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
