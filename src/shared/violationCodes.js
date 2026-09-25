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
  FOCUS_LOST: "focus_lost",
  VIRTUAL_DESKTOP: "virtual_desktop",
});

const ALL_CODES = new Set(Object.values(CODE));

// Never hard blocks: the site decides. Extra displays are strikes on its own limit, and
// leaving the window is already struck by the site's own focus tracking.
const STRIKE_CODES = new Set([
  CODE.EXTERNAL_DISPLAY,
  CODE.MIRRORED_DISPLAY,
  CODE.FOCUS_LOST,
  CODE.VIRTUAL_DESKTOP,
]);

// What the site and the backend are told about an agent threat. The agent's own
// detail can hold file paths, window titles and IP addresses, so it stays local.
const THREAT_EVENTS = {
  [CODE.AI_TOOL]: "AI tool detected",
  [CODE.OVERLAY]: "See-through overlay window detected",
  [CODE.RENAMED_APP]: "Renamed blocked app detected",
  [CODE.REMOTE_SESSION]: "Remote desktop session detected",
  [CODE.VIRTUAL_MACHINE]: "Virtual machine detected",
  [CODE.SUSPICIOUS_ACTIVITY]: "Suspicious activity detected",
};

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

function isStrikeCode(code) {
  return STRIKE_CODES.has(code);
}

/**
 * @param {string} code - a threat's code
 * @param {string[]} [apps] - display names
 * @returns {string} e.g. "AI tool detected: parakeetai-desktop"
 */
function threatEvent(code, apps = []) {
  const base = THREAT_EVENTS[code] || THREAT_EVENTS[CODE.SUSPICIOUS_ACTIVITY];
  const names = [...new Set(apps.filter(Boolean))];
  return names.length > 0 ? `${base}: ${names.join(", ")}` : base;
}

module.exports = {
  CODE,
  codeForThreat,
  codeForProcessCategory,
  isKnownCode,
  isStrikeCode,
  threatEvent,
};
