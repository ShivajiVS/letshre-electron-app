/**
 * preload.js
 * ──────────
 * Renderer context bridge — runs in a sandboxed context before the page loads.
 *
 * NOTE: With sandbox:true, Node's require() is NOT available for local files.
 * Only require('electron') works. IPC channel names are therefore inlined here
 * directly (they mirror src/shared/constants.js — keep them in sync).
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
  QUIT_APP: "quit-app",
  RECHECK_SYSTEM: "recheck-system",
  RUN_PREFLIGHT: "run-preflight-scans",
  PROCEED_TO_INTERVIEW: "proceed-to-interview",
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",
};

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  /** Quit the application. */
  quitApp: () => ipcRenderer.send(IPC.QUIT_APP),

  /** Reload the preflight screen and reset detection state. */
  recheckSystem: () => ipcRenderer.send(IPC.RECHECK_SYSTEM),

  /** Run all preflight security scans and return combined results. */
  runPreflight: () => ipcRenderer.invoke(IPC.RUN_PREFLIGHT),

  /** Activate interview lockdown mode and navigate to the interview URL. */
  proceedToInterview: () => ipcRenderer.send(IPC.PROCEED_TO_INTERVIEW),

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
