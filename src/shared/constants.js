/**
 * src/shared/constants.js
 * ───────────────────────
 * Single source of truth for all magic values used across the app.
 * Import from here — never hard-code ports, URLs, or IPC channel strings.
 */

"use strict";

// ─── Backend / Agent ─────────────────────────────────────────────────────────

/** Port the Python security agent listens on. */
const AGENT_PORT = 9999;

/** Loopback host for the Python security agent. */
const AGENT_HOST = "127.0.0.1";

/** Max ms to wait for agent to become ready after spawn. */
const AGENT_PING_TIMEOUT_MS = 6000;

/** Interval between each poll attempt while waiting for agent. */
const AGENT_POLL_INTERVAL_MS = 500;

/** Max wait per individual HTTP request to agent. */
const AGENT_REQUEST_TIMEOUT_MS = 2000;

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Base URL of the interview web app. */
const INTERVIEW_BASE_URL = "https://interview.letshyre.com";

/** Base URL of the LetsHyre REST API. */
const API_BASE_URL = "https://api.letshyre.com";

// ─── Detection / Violation ───────────────────────────────────────────────────

/** Minimum ms between repeated reports of the same violation event. */
const VIOLATION_COOLDOWN_MS = 15000;

/** How often (ms) to run hardware + agent deep-scan polls during interview. */
const DETECTION_INTERVAL_MS = 5000;

/** How often (ms) to ping the agent for anti-tamper checks. */
const TAMPER_CHECK_INTERVAL_MS = 10000;

/** How often (ms) the Electron app sends a heartbeat to the backend during interview. */
const HEARTBEAT_INTERVAL_MS = 30000;

// ─── IPC Channel Names ───────────────────────────────────────────────────────
// Keep these in sync with preload.js exposures and ipcHandlers.js registrations.
//
// Convention:
//   - Plain names  → renderer invokes main (ipcRenderer.send / invoke)
//   - PUSH_ prefix → main pushes to renderer (webContents.send)

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

  // Auto-updater (main → renderer push)
  PUSH_UPDATE_AVAILABLE: "push-update-available",
  PUSH_UPDATE_DOWNLOADED: "push-update-downloaded",

  // Auto-updater (renderer → main)
  INSTALL_UPDATE: "install-update",

  // Audit trail
  GET_AUDIT_LOG: "get-audit-log",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Streaming preflight — main pushes per-step results as they complete
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push (forwarded to interview.letshyre.com website)
  PUSH_VIOLATION: "push-violation",
};

// ─── Custom Protocol ─────────────────────────────────────────────────────────

/** The custom deep-link scheme registered with the OS. */
const PROTOCOL_SCHEME = "letshyre";

module.exports = {
  AGENT_PORT,
  AGENT_HOST,
  AGENT_PING_TIMEOUT_MS,
  AGENT_POLL_INTERVAL_MS,
  AGENT_REQUEST_TIMEOUT_MS,
  INTERVIEW_BASE_URL,
  API_BASE_URL,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  TAMPER_CHECK_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  IPC,
  PROTOCOL_SCHEME,
};
