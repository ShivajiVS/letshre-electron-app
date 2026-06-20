/**
 * preload.js
 * ──────────
 * Renderer context bridge — runs in a sandboxed context before the page loads.
 *
 * NOTE: With sandbox:true, Node's require() is NOT available for local files.
 * Only require('electron') works. IPC channel names are therefore inlined here
 * directly (they mirror src/shared/constants.js IPC — keep them in sync).
 *
 * Security hardening (capture phase):
 *   - Blocks right-click context menu
 *   - Blocks copy/paste/view-source keyboard shortcuts
 *   - Blocks PrintScreen
 */

/* eslint-env browser */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// ─── IPC Channel Names (mirrors src/shared/constants.js IPC object) ───────────
// Cannot require() the shared file here due to sandbox:true restriction.
const IPC = {
  // App control
  QUIT_APP: "quit-app",
  RECHECK_SYSTEM: "recheck-system",

  // Preflight
  RUN_PREFLIGHT: "run-preflight-scans",

  // Interview flow
  PROCEED_TO_INTERVIEW: "proceed-to-interview",

  // Process management
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",

  // Auto-updater — push events (main → renderer)
  PUSH_UPDATE_AVAILABLE: "push-update-available",
  PUSH_UPDATE_DOWNLOADED: "push-update-downloaded",
  PUSH_UPDATE_PROGRESS: "push-update-progress",
  PUSH_UPDATE_ERROR: "push-update-error",
  PUSH_UPDATE_STATE: "push-update-state",

  // Auto-updater — invoke (renderer → main)
  INSTALL_UPDATE: "install-update",
  GET_UPDATE_STATE: "get-update-state",

  // App version (renderer invoke → main)
  GET_APP_VERSION: "get-app-version",

  // Audit trail
  GET_AUDIT_LOG: "get-audit-log",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Per-step preflight progress push (main → renderer)
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push during active interview
  PUSH_VIOLATION: "push-violation",

  // Interview session end: website → main
  INTERVIEW_COMPLETE: "interview-complete",

  // Violation acknowledgement: website → main
  ACK_VIOLATION: "ack-violation",

  // App list (ADD-10)
  GET_APP_LIST: "get-app-list",

  // Pre-proceed watcher: main → renderer push — real-time blocked-app status
  PUSH_PRE_PROCEED_STATUS: "push-pre-proceed-status",
};

// Hardened IPC wrapper — only whitelisted channels are allowed
const ALLOWED_SEND_CHANNELS = [
  IPC.QUIT_APP, IPC.RECHECK_SYSTEM, IPC.PROCEED_TO_INTERVIEW,
  IPC.INSTALL_UPDATE, IPC.MINIMIZE_WINDOW,
  IPC.INTERVIEW_COMPLETE, IPC.ACK_VIOLATION,
];

const ALLOWED_INVOKE_CHANNELS = [
  IPC.RUN_PREFLIGHT, IPC.KILL_BLOCKED_APP,
  IPC.KILL_ALL_BLOCKED_APPS, IPC.GET_AUDIT_LOG, IPC.GET_APP_LIST,
  IPC.GET_APP_VERSION, IPC.GET_UPDATE_STATE,
];

const ALLOWED_RECEIVE_CHANNELS = [
  IPC.PUSH_UPDATE_AVAILABLE, IPC.PUSH_UPDATE_DOWNLOADED,
  IPC.PUSH_UPDATE_PROGRESS, IPC.PUSH_UPDATE_ERROR, IPC.PUSH_UPDATE_STATE,
  IPC.PUSH_WARNING, IPC.PREFLIGHT_PROGRESS, IPC.PUSH_VIOLATION,
  IPC.PUSH_PRE_PROCEED_STATUS,
];

function safeSend(channel, ...args) {
  if (ALLOWED_SEND_CHANNELS.includes(channel)) {
    ipcRenderer.send(channel, ...args);
  }
}

function safeInvoke(channel, ...args) {
  if (ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
  return Promise.reject(new Error(`Channel not allowed: ${channel}`));
}

function safeOn(channel, callback) {
  if (ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
    ipcRenderer.on(channel, callback);
  }
}

// ADD-02: Tracked handler reference so we can remove it on rescan without removeAllListeners.
// Module-level variable — one active preflight listener at a time.
let _preflightProgressHandler = null;

// Violation bridge: tracked handler so we can deregister cleanly on unmount.
let _violationHandler = null;

let _updateAvailableHandler = null;
let _updateDownloadedHandler = null;
let _updateProgressHandler = null;
let _updateErrorHandler = null;
let _updateStateHandler = null;
let _warningHandler = null;

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  // ── App control ────────────────────────────────────────────────────────────
  /** Quit the application. */
  quitApp: () => safeSend(IPC.QUIT_APP),

  /** Reload the preflight screen and reset detection state. */
  recheckSystem: () => safeSend(IPC.RECHECK_SYSTEM),

  /**
   * Minimize the window so the user can manually close apps flagged by the
   * preflight scan. Only works during requirements/preflight — ignored during
   * active interview (window lock takes precedence).
   */
  minimizeWindow: () => safeSend(IPC.MINIMIZE_WINDOW),

  // ── Preflight ──────────────────────────────────────────────────────────────
  /** Run all preflight security scans and return combined results. */
  runPreflight: () => safeInvoke(IPC.RUN_PREFLIGHT),

  // ── Interview flow ─────────────────────────────────────────────────────────
  /** Activate interview lockdown mode and navigate to the interview URL. */
  proceedToInterview: () => safeSend(IPC.PROCEED_TO_INTERVIEW),

  // ── Process management ─────────────────────────────────────────────────────
  /**
   * Force-terminate a single blocked process.
   * @param {string} processName
   */
  killProcess: (processName) =>
    safeInvoke(IPC.KILL_BLOCKED_APP, processName),

  /**
   * Force-terminate multiple blocked processes at once.
   * @param {string[]} processNames
   */
  killAllProcesses: (processNames) =>
    safeInvoke(IPC.KILL_ALL_BLOCKED_APPS, processNames),

  // ── Auto-updater (ADD-01) ──────────────────────────────────────────────────
  /**
   * Subscribe to update-available events from the main process.
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateAvailable: (callback) => {
    if (_updateAvailableHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
    }
    _updateAvailableHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
  },
  removeUpdateAvailableListener: () => {
    if (_updateAvailableHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
      _updateAvailableHandler = null;
    }
  },

  /**
   * Subscribe to update-downloaded events (update ready to install).
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateDownloaded: (callback) => {
    if (_updateDownloadedHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
    }
    _updateDownloadedHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
  },
  removeUpdateDownloadedListener: () => {
    if (_updateDownloadedHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
      _updateDownloadedHandler = null;
    }
  },

  /** Quit the app and silently install the downloaded update (ignored during an interview). */
  installUpdate: () => safeSend(IPC.INSTALL_UPDATE),

  /** Pull the current updater snapshot to recover any events missed before listeners attached. */
  getUpdateState: () => safeInvoke(IPC.GET_UPDATE_STATE),

  /**
   * Subscribe to download-progress events.
   * @param {(data: { percent: number, bytesPerSecond?: number }) => void} callback
   */
  onUpdateProgress: (callback) => {
    if (_updateProgressHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_PROGRESS, _updateProgressHandler);
    }
    _updateProgressHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_PROGRESS, _updateProgressHandler);
  },

  /**
   * Subscribe to updater error events.
   * @param {(data: { error: string }) => void} callback
   */
  onUpdateError: (callback) => {
    if (_updateErrorHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_ERROR, _updateErrorHandler);
    }
    _updateErrorHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_ERROR, _updateErrorHandler);
  },

  /**
   * Subscribe to coarse updater state changes (idle/checking/available/
   * downloading/downloaded/error).
   * @param {(data: { state: string, version?: string|null }) => void} callback
   */
  onUpdateState: (callback) => {
    if (_updateStateHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_STATE, _updateStateHandler);
    }
    _updateStateHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_STATE, _updateStateHandler);
  },

  /** Returns the running application version string. */
  getAppVersion: () => safeInvoke(IPC.GET_APP_VERSION),

  // ── Audit trail (ADD-07) ───────────────────────────────────────────────────
  /** Fetch the full in-memory session audit log. */
  getAuditLog: () => safeInvoke(IPC.GET_AUDIT_LOG),

  // ── Streaming Preflight (ADD-02) ───────────────────────────────────────────
  /**
   * Subscribe to per-step preflight progress events.
   * Replaces the previous single-response approach — cards update as each
   * check completes instead of all at once at the end.
   * Automatically removes any previously registered listener before adding.
   * @param {(data: { step: string, status: 'running'|'done', result: any }) => void} callback
   */
  onPreflightProgress: (callback) => {
    if (_preflightProgressHandler) {
      ipcRenderer.removeListener(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
    }
    _preflightProgressHandler = (_event, data) => callback(data);
    safeOn(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
  },

  /**
   * Remove the active preflight progress listener.
   * Always call this in the finally block of runScans().
   */
  removePreflightProgressListener: () => {
    if (_preflightProgressHandler) {
      ipcRenderer.removeListener(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
      _preflightProgressHandler = null;
    }
  },

  // ── Warning push (ADD-06) ─────────────────────────────────────────────────
  /**
   * Subscribe to soft-violation warning pushes from the main process.
   * @param {(data: { message: string, severity: string }) => void} callback
   */
  onWarning: (callback) => {
    if (_warningHandler) {
      ipcRenderer.removeListener(IPC.PUSH_WARNING, _warningHandler);
    }
    _warningHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_WARNING, _warningHandler);
  },
  removeWarningListener: () => {
    if (_warningHandler) {
      ipcRenderer.removeListener(IPC.PUSH_WARNING, _warningHandler);
      _warningHandler = null;
    }
  },

  // ── Violation bridge (interview active phase) ───────────────────────────────
  /**
   * Register a callback to receive ALL violation events pushed from the
   * Electron main process during an active interview session.
   *
   * The payload shape:
   *   { event, severity, count, isHardBlock, source, timestamp }
   *
   * isHardBlock: true  → terminate session (website decides UI)
   * isHardBlock: false → show warning toast (interview continues)
   *
   * Safe to call multiple times (e.g. React re-render) — previous listener
   * is removed before the new one is registered to prevent duplicates.
   *
   * @param {(payload: object) => void} callback
   */
  onViolation: (callback) => {
    if (_violationHandler) {
      ipcRenderer.removeListener(IPC.PUSH_VIOLATION, _violationHandler);
    }
    _violationHandler = (_, payload) => callback(payload);
    safeOn(IPC.PUSH_VIOLATION, _violationHandler);
  },

  /**
   * Unregister the violation listener.
   * Call this on component unmount or session end to avoid memory leaks.
   */
  removeViolationListener: () => {
    if (_violationHandler) {
      ipcRenderer.removeListener(IPC.PUSH_VIOLATION, _violationHandler);
      _violationHandler = null;
    }
  },

  /**
   * Acknowledge a received violation. Call this from your onViolation handler
   * (hard AND soft) to tell Electron the renderer is alive and handling it.
   * While acks keep arriving, Electron will NOT self-enforce — your in-app
   * warning/termination flow stays in control. If acks stop (page crashed /
   * listener dropped), Electron falls back to its own violation screen.
   *
   * Safe to call in a plain browser — no-ops if electronAPI is unavailable.
   */
  acknowledgeViolation: () => safeSend(IPC.ACK_VIOLATION),

  // ── Interview session end ─────────────────────────────────────────────────
  /**
   * Signal to Electron that the interview session has ended.
   * Electron will exit kiosk mode and restore close / minimize access.
   *
   * Safe to call in a regular browser — no-ops if electronAPI is unavailable.
   *
   * @param {"completed"|"auto-submitted"|"terminated"|"expired"} reason
   */
  interviewComplete: (reason) =>
    safeSend(IPC.INTERVIEW_COMPLETE, { reason }),

  getAppList: () => safeInvoke(IPC.GET_APP_LIST),

  // ── Pre-proceed watcher (background blocked-app status) ───────────────────
  /**
   * Subscribe to real-time blocked-app status pushes from the background
   * pre-proceed watcher (active after preflight passes, stopped on Proceed).
   *
   * Payload: { clean: boolean, apps: string[] }
   *   clean: true  → all clear, Proceed button should be enabled
   *   clean: false → blocked apps still running, Proceed should be disabled
   *
   * @param {(payload: { clean: boolean, apps: string[] }) => void} callback
   */
  onPreProceedStatus: (callback) => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PRE_PROCEED_STATUS);
    safeOn(IPC.PUSH_PRE_PROCEED_STATUS, (_e, data) => callback(data));
  },

  /** Unsubscribe when leaving the preflight screen. */
  removePreProceedStatusListener: () => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PRE_PROCEED_STATUS);
  },
});

// ─── Input Security (capture phase) ─────────────────────────────────────────
// Use capture:true to intercept events BEFORE the webpage can stop them.

document.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    // Block Copy (C), Paste (V), View Source (U) on Windows (Ctrl) and Mac (Cmd)
    if (
      (e.ctrlKey || e.metaKey) &&
      ["c", "v", "u"].includes(e.key.toLowerCase())
    ) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Block PrintScreen
    if (e.key === "PrintScreen") {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);
