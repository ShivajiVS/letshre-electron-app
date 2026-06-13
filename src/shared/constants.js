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

// ─── IPC Channel Names ───────────────────────────────────────────────────────
// Keep these in sync with preload.js exposures and ipcHandlers.js registrations.

const IPC = {
  QUIT_APP: "quit-app",
  RECHECK_SYSTEM: "recheck-system",
  RUN_PREFLIGHT: "run-preflight-scans",
  PROCEED_TO_INTERVIEW: "proceed-to-interview",
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",
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
  IPC,
  PROTOCOL_SCHEME,
};
