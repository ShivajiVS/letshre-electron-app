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

  // Auto-updater — invoke (renderer → main)
  INSTALL_UPDATE: "install-update",

  // Audit trail
  GET_AUDIT_LOG: "get-audit-log",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Per-step preflight progress push (main → renderer)
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",
};

// ADD-02: Tracked handler reference so we can remove it on rescan without removeAllListeners.
// Module-level variable — one active preflight listener at a time.
let _preflightProgressHandler = null;

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  // ── App control ────────────────────────────────────────────────────────────
  /** Quit the application. */
  quitApp: () => ipcRenderer.send(IPC.QUIT_APP),

  /** Reload the preflight screen and reset detection state. */
  recheckSystem: () => ipcRenderer.send(IPC.RECHECK_SYSTEM),

  /**
   * Minimize the window so the user can manually close apps flagged by the
   * preflight scan. Only works during requirements/preflight — ignored during
   * active interview (window lock takes precedence).
   */
  minimizeWindow: () => ipcRenderer.send(IPC.MINIMIZE_WINDOW),

  // ── Preflight ──────────────────────────────────────────────────────────────
  /** Run all preflight security scans and return combined results. */
  runPreflight: () => ipcRenderer.invoke(IPC.RUN_PREFLIGHT),

  // ── Interview flow ─────────────────────────────────────────────────────────
  /** Activate interview lockdown mode and navigate to the interview URL. */
  proceedToInterview: () => ipcRenderer.send(IPC.PROCEED_TO_INTERVIEW),

  // ── Process management ─────────────────────────────────────────────────────
  /**
   * Force-terminate a single blocked process.
   * @param {string} processName
   */
  killProcess: (processName) =>
    ipcRenderer.invoke(IPC.KILL_BLOCKED_APP, processName),

  /**
   * Force-terminate multiple blocked processes at once.
   * @param {string[]} processNames
   */
  killAllProcesses: (processNames) =>
    ipcRenderer.invoke(IPC.KILL_ALL_BLOCKED_APPS, processNames),

  // ── Auto-updater (ADD-01) ──────────────────────────────────────────────────
  /**
   * Subscribe to update-available events from the main process.
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateAvailable: (callback) =>
    ipcRenderer.on(IPC.PUSH_UPDATE_AVAILABLE, (_event, data) => callback(data)),

  /**
   * Subscribe to update-downloaded events (update ready to install).
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateDownloaded: (callback) =>
    ipcRenderer.on(IPC.PUSH_UPDATE_DOWNLOADED, (_event, data) => callback(data)),

  /** Quit the app and install the downloaded update. */
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),

  // ── Audit trail (ADD-07) ───────────────────────────────────────────────────
  /** Fetch the full in-memory session audit log. */
  getAuditLog: () => ipcRenderer.invoke(IPC.GET_AUDIT_LOG),

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
    ipcRenderer.on(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
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
  onWarning: (callback) =>
    ipcRenderer.on(IPC.PUSH_WARNING, (_event, data) => callback(data)),
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
