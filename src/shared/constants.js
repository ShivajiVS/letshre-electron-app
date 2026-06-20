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
const AGENT_PING_TIMEOUT_MS = 15000;

/** Interval between each poll attempt while waiting for agent. */
const AGENT_POLL_INTERVAL_MS = 500;

/** Max wait per individual HTTP request to agent. */
const AGENT_REQUEST_TIMEOUT_MS = 2000;

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Base URL of the interview web app. */
const INTERVIEW_BASE_URL = "https://interview.letshyre.com";

/** Base URL of the LetsHyre REST API. Overridable via env for staging / tests. */
const API_BASE_URL = process.env.API_BASE_URL || "https://api.letshyre.com";

// ─── Detection / Violation ───────────────────────────────────────────────────

/** Minimum ms between repeated reports of the same violation event. */
const VIOLATION_COOLDOWN_MS = 15000;

/** How often (ms) to run hardware + agent deep-scan polls during interview. */
const DETECTION_INTERVAL_MS = 5000;

/** How often (ms) the Electron app sends a heartbeat to the backend during interview. */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * How often (ms) to re-check GitHub for app updates. Checks are SUPPRESSED while
 * an interview is active — a proctor client must never restart mid-session.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Fail-CLOSED policy: number of consecutive "indeterminate" results (a check
 * that errored / timed out and therefore could not confirm the system is clean)
 * tolerated during an ACTIVE interview before the check is escalated to a
 * violation. At DETECTION_INTERVAL_MS = 5s, a value of 3 ≈ 15s of blind spot.
 * This closes the previous silent fail-OPEN hole where any transient probe
 * error was treated as "secure".
 */
const INDETERMINATE_ESCALATION_THRESHOLD = 3;

/**
 * Grace period (ms) after a hard-block violation before Electron SELF-ENFORCES.
 * The violation is pushed to the website first; if the session is still active
 * after this window (the site dropped the event or failed to terminate),
 * Electron lifts the lockdown and shows the local violation screen itself.
 * This closes the gap where renderer-only enforcement = silent bypass.
 */
const HARD_BLOCK_GRACE_MS = 8000;

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
  PUSH_UPDATE_PROGRESS: "push-update-progress",
  PUSH_UPDATE_ERROR: "push-update-error",
  PUSH_UPDATE_STATE: "push-update-state",

  // Auto-updater (renderer → main)
  INSTALL_UPDATE: "install-update",

  // Auto-updater state pull (renderer invoke → main) — recover missed events
  GET_UPDATE_STATE: "get-update-state",

  // App version (renderer invoke → main)
  GET_APP_VERSION: "get-app-version",

  // Audit trail (ADD-07)
  GET_AUDIT_LOG: "get-audit-log",

  // App list (ADD-10)
  GET_APP_LIST: "get-app-list",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Streaming preflight — main pushes per-step results as they complete
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push (forwarded to interview.letshyre.com website)
  PUSH_VIOLATION: "push-violation",

  // Interview session end: website → main (lifts window lockdown)
  INTERVIEW_COMPLETE: "interview-complete",

  // Violation acknowledgement: website → main. The renderer calls this from its
  // onViolation handler to confirm it received and is handling the violation.
  // While acks keep arriving, Electron's self-enforcement failsafe stays
  // suppressed (the website owns the warning/termination UX). If acks stop
  // (renderer crashed / listener dropped), the failsafe self-enforces.
  ACK_VIOLATION: "ack-violation",

  // Pre-proceed watcher: main → renderer push — real-time blocked-app status
  // while the user is on the "All checks passed" success screen.
  // Payload: { clean: boolean, apps: string[] }
  PUSH_PRE_PROCEED_STATUS: "push-pre-proceed-status",
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
  HEARTBEAT_INTERVAL_MS,
  UPDATE_CHECK_INTERVAL_MS,
  INDETERMINATE_ESCALATION_THRESHOLD,
  HARD_BLOCK_GRACE_MS,
  IPC,
  PROTOCOL_SCHEME,
};
