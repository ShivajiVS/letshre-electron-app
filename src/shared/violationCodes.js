// Stable machine-readable codes for everything the security checks can flag.
// The pre-interview guard and the live interview detection both use these, and
// the interview site keys its copy and handling off them (README "Web app integration").

"use strict";

const CODE = Object.freeze({
  BLOCKED_APP: "blocked_app",
  AI_TOOL: "ai_tool",
  OVERLAY: "overlay",
  RENAMED_APP: "renamed_app",
  EXTERNAL_DISPLAY: "external_display",
  MIRRORED_DISPLAY: "mirrored_display",
  REMOTE_SESSION: "remote_session",
  VIRTUAL_MACHINE: "virtual_machine",
  SUSPICIOUS_ACTIVITY: "suspicious_activity",
  AGENT_UNREACHABLE: "agent_unreachable",
  CHECK_UNVERIFIED: "check_unverified",
  WINDOW_MINIMIZE: "window_minimize",
  FULLSCREEN_EXIT: "fullscreen_exit",
  CLOSE_ATTEMPT: "close_attempt",
});

const ALL_CODES = new Set(Object.values(CODE));

const THREAT_CODES = {
  ai_cheating_tool: CODE.AI_TOOL,
  transparent_overlay: CODE.OVERLAY,
  renamed_blocked_app: CODE.RENAMED_APP,
  remote_session: CODE.REMOTE_SESSION,
  virtual_machine: CODE.VIRTUAL_MACHINE,
};

/** @param {{type?: string}|null|undefined} threat - one agent threat row */
function codeForThreat(threat) {
  return THREAT_CODES[threat?.type] || CODE.SUSPICIOUS_ACTIVITY;
}

/** @param {string} category - a blocklist category (meeting, screen, wireless, browser, ai) */
function codeForProcessCategory(category) {
  return category === "ai" ? CODE.AI_TOOL : CODE.BLOCKED_APP;
}

function isKnownCode(code) {
  return ALL_CODES.has(code);
}

module.exports = { CODE, codeForThreat, codeForProcessCategory, isKnownCode };
