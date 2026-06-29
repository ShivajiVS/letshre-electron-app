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
const updater = require("./updater");
const logger = require("./logger");
const appState = require("./appState");
const { IPC } = require("../shared/constants");
const { killSingleProcess, killAllProcesses } = require("./processKiller");
const { lockdownForInterview, endInterview, getWindow, minimizeWindow, loadSecurityCheck, loadPermissionsPage } = require("./windowManager");
const { invalidateProcessCache } = require("../detector/mirrorDetector");
const { getCurrentInterviewUrl, setInterviewSession } = require("./protocolHandler");
const { ensureAgent } = require("./agentManager");
const authManager = require("./authManager");
const startDetection = require("../detector/systemChecks");
const { startPreProceedMonitor, stopPreProceedMonitor } = startDetection;

const { MEETING_APPS, SCREEN_SHARING_APPS, AI_CHEATING_APPS, APP_DISPLAY_NAMES } = require("../shared/appList");

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
  // ── Auth ───────────────────────────────────────────────────────────────────
  // Tokens are handled entirely in main (authManager); the renderer only ever
  // receives display-safe user fields.

  ipcMain.handle(IPC.AUTH_LOGIN, async (_event, creds) => {
    const email = typeof creds?.email === "string" ? creds.email.trim() : "";
    const password = typeof creds?.password === "string" ? creds.password : "";
    if (!email || !password) {
      return { success: false, message: "Email and password are required." };
    }
    logger.info("[ipc] auth-login for", email);
    return await authManager.login(email, password);
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    logger.info("[ipc] auth-logout received");
    return await authManager.logout();
  });

  ipcMain.handle(IPC.GET_AUTH_USER, () => authManager.getUser());

  ipcMain.handle(IPC.GET_CANDIDATE_PROFILE, async () => {
    logger.info("[ipc] get-candidate-profile");
    return await authManager.getCandidateProfile();
  });

  // Dashboard "Take Interview": set the interview session from the logged-in
  // tokens, then hand off to the EXISTING security-check screen.
  ipcMain.on(IPC.START_INTERVIEW, () => {
    const tokens = authManager.getTokens();
    if (!tokens) {
      logger.warn("[ipc] start-interview rejected — not authenticated");
      return;
    }
    logger.info("[ipc] start-interview — entering security check");
    setInterviewSession(tokens.accessToken, tokens.refreshToken);
    loadSecurityCheck();
  });

  // Preflight "Proceed" → load the permissions page (NOT locked down yet;
  // the OS needs to present native mic/camera/screen dialogs).
  ipcMain.on(IPC.LOAD_PERMISSIONS_PAGE, () => {
    logger.info("[ipc] load-permissions-page");
    loadPermissionsPage();
  });

  // ── App Control ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_APP_LIST, () => ({
    meetingApps: MEETING_APPS,
    screenSharingApps: SCREEN_SHARING_APPS,
    aiCheatingApps: AI_CHEATING_APPS,
    displayNames: APP_DISPLAY_NAMES,
  }));

  ipcMain.on(IPC.QUIT_APP, () => {
    logger.info("[ipc] quit-app received");
    appState.setQuitting();
    app.quit();
  });

  // Preflight UX: user can minimize to close other apps manually before rescanning
  ipcMain.on(IPC.MINIMIZE_WINDOW, () => {
    minimizeWindow();
  });

  ipcMain.on(IPC.RECHECK_SYSTEM, () => {
    const win = getWindow();
    if (!win) { return; }
    logger.info("[ipc] recheck-system received");
    stopPreProceedMonitor();
    invalidateProcessCache();
    if (startDetection.resetState) { startDetection.resetState(); }
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.RUN_PREFLIGHT, async (event) => {
    logger.info("[ipc] run-preflight-scans invoked");

    // Self-heal: respawn the agent if it has died, so a transient failure is
    // recoverable by re-scanning rather than permanently blocking Proceed.
    try {
      await ensureAgent();
    } catch (err) {
      logger.warn("[ipc] ensureAgent failed:", err.message);
    }

    // ADD-02: Streaming preflight — push progress for each step as it completes.
    // event.sender.send() is safe to call from within an ipcMain.handle() handler.
    const onProgress = (step, status, result) => {
      try {
        event.sender.send(IPC.PREFLIGHT_PROGRESS, { step, status, result });
      } catch {
        // Renderer was destroyed before the scan finished — ignore
      }
    };

    const result = await startDetection.runChecksOnce(onProgress);

    // Start the background pre-proceed watcher as soon as preflight is done.
    // It polls checkProcesses() every 2s and pushes { clean, apps } to the
    // renderer — this keeps the Proceed button state accurate without any
    // blocking scan at click-time.
    startPreProceedMonitor(getWindow());

    return result;
  });

  //Interview Flow
  ipcMain.on(IPC.PROCEED_TO_INTERVIEW, () => {
    logger.info("[ipc] proceed-to-interview received");
    // Stop the pre-proceed watcher — no longer needed once interview starts.
    stopPreProceedMonitor();

    const interviewUrl = getCurrentInterviewUrl();
    lockdownForInterview(interviewUrl);

    try {
      const win = getWindow();
      startDetection.start(win);
    } catch (err) {
      logger.error("[ipc] detection start failed:", err.message);
    }
  });

  //Process Management 
  ipcMain.handle(IPC.KILL_BLOCKED_APP, async (_event, processName) => {
    // IMP-03: Validate and sanitise before passing to processKiller
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app rejected — invalid processName:", processName);
      return { success: false, error: "Invalid process name", processName: String(processName).slice(0, 40) };
    }
    logger.info("[ipc] kill-blocked-app:", safe);
    const result = await killSingleProcess(safe);
    // Drop the 3s process cache so the next scan reflects the kill immediately
    // (otherwise the just-killed app shows as still running until the TTL).
    invalidateProcessCache();
    return result;
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
    const results = await killAllProcesses(validNames);
    invalidateProcessCache(); // refresh cache so killed apps clear immediately
    return results;
  });

  // ── Auto-Updater ─────────────────────────────────────────────────────────
  //Renderer can trigger install after update-downloaded event.

  ipcMain.on(IPC.INSTALL_UPDATE, () => {
    logger.info("[ipc] install-update received");
    // Gated internally — refuses during an active interview.
    updater.installUpdate();
  });

  // Renderer pulls the current updater snapshot on load to recover any
  // state/progress events it missed before its listeners were attached.
  ipcMain.handle(IPC.GET_UPDATE_STATE, () => updater.getState());

  // Renderer asks for the running app version (shown in the preflight footer).
  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion());

  //Audit Trail
  // ADD-07: Exposes the in-memory audit log to the renderer (support diagnostics).

  ipcMain.handle(IPC.GET_AUDIT_LOG, () => {
    return startDetection.getAuditLog ? startDetection.getAuditLog() : [];
  });

  //Interview Complete
  // Signal sent by interview.letshyre.com when the session ends.
  // Stops all detection loops and lifts the window lockdown.

  // Renderer acknowledges it received & is handling a violation — keeps the
  // self-enforcement failsafe suppressed while the website stays responsive.
  ipcMain.on(IPC.ACK_VIOLATION, () => {
    if (startDetection.acknowledgeViolation) {
      startDetection.acknowledgeViolation();
    }
  });

  ipcMain.on(IPC.INTERVIEW_COMPLETE, (_event, { reason } = {}) => {
    const safeReason = typeof reason === "string" ? reason.slice(0, 40) : "unknown";
    logger.info(`[ipc] interview-complete received — reason: ${safeReason}`);

    // Stop all active detection / polling loops
    if (startDetection.stop) { startDetection.stop(); }

    // Lift window lockdown (allows close, minimize, etc.)
    endInterview(safeReason);

    // Safe moment to surface any held update / re-check.
    updater.onInterviewEnded();
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
