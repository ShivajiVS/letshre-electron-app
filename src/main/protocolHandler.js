/**
 * src/main/protocolHandler.js
 * ───────────────────────────
 * Owns everything related to the `letshyre://` custom deep-link protocol:
 *   - Parsing URL parameters
 *   - Building the interview URL
 *   - Handling incoming protocol activations (new launches + second instances)
 *
 * State (currentInterviewUrl, currentAccessToken) is managed here and
 * read by windowManager and ipcHandlers via the exported getters.
 */

"use strict";

const logger = require("./logger");
const { INTERVIEW_BASE_URL } = require("../shared/constants");

// ─── State ───────────────────────────────────────────────────────────────────

let currentInterviewUrl = INTERVIEW_BASE_URL;
let currentAccessToken = null;

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Parses a letshyre:// deep-link URL and extracts access/refresh tokens.
 * @param {string} url
 * @returns {{ accessToken: string|null, refreshToken: string|null }}
 */
function getParams(url) {
  try {
    const parsed = new URL(url);
    return {
      accessToken: parsed.searchParams.get("ac"),
      refreshToken: parsed.searchParams.get("rc"),
    };
  } catch (err) {
    logger.warn("[protocol] URL parse error:", err.message);
    return { accessToken: null, refreshToken: null };
  }
}

/**
 * Builds the fully-qualified interview URL from extracted params.
 * @param {{ accessToken: string|null, refreshToken: string|null }} params
 * @returns {string}
 */
function buildInterviewUrl(params) {
  let url = INTERVIEW_BASE_URL;
  if (params.accessToken) {
    url += `?ac=${encodeURIComponent(params.accessToken)}`;
    if (params.refreshToken) {
      url += `&rc=${encodeURIComponent(params.refreshToken)}`;
    }
  }
  return url;
}

// ─── Protocol Activation ─────────────────────────────────────────────────────

/**
 * Handles an incoming letshyre:// deep-link.
 * Updates state and optionally redirects the active window.
 *
 * @param {string} url - The full letshyre:// URL
 * @param {Electron.BrowserWindow | null} win - Current window reference
 * @param {boolean} isInterviewActive - Whether an interview session is active
 * @param {(event: string, severity: string) => void} onViolation
 */
function handleIncomingProtocol(url, win, isInterviewActive, onViolation) {
  const params = getParams(url);
  currentAccessToken = params.accessToken || null;
  currentInterviewUrl = buildInterviewUrl(params);

  if (!win) {return;}

  if (win.isMinimized()) {win.restore();}
  win.focus();

  if (isInterviewActive) {
    // Security: mid-interview protocol swap could be an exploit — treat as violation.
    onViolation("Attempted protocol swap during active interview", "high");
    win.loadURL(currentInterviewUrl);
  } else {
    // Still in preflight — silently update the target URL.
    logger.info("[protocol] updated target interview URL:", currentInterviewUrl);
  }
}

// ─── Accessors ───────────────────────────────────────────────────────────────

/** Returns the currently active interview URL. */
function getCurrentInterviewUrl() {
  return currentInterviewUrl;
}

/** Returns the currently active access token. */
function getCurrentAccessToken() {
  return currentAccessToken;
}

/**
 * Sets the interview session from already-obtained tokens (the login flow).
 * Reuses buildInterviewUrl so the interview opens with ?ac=&rc= exactly as the
 * deep-link path did — the downstream preflight → lockdown → interview flow is
 * unchanged.
 * @param {string} accessToken
 * @param {string} refreshToken
 */
function setInterviewSession(accessToken, refreshToken) {
  currentAccessToken = accessToken || null;
  currentInterviewUrl = buildInterviewUrl({ accessToken, refreshToken });
  logger.info("[protocol] interview session set from login tokens");
}

/**
 * Applies a deep-link URL from argv on initial Windows launch.
 * @param {string[]} argv
 */
function applyArgvDeepLink(argv) {
  const url = argv.find((arg) => arg.startsWith("letshyre://"));
  if (!url) {return;}
  const params = getParams(url);
  currentAccessToken = params.accessToken || null;
  currentInterviewUrl = buildInterviewUrl(params);
  logger.info("[protocol] applied deep-link from argv:", currentInterviewUrl);
}

module.exports = {
  handleIncomingProtocol,
  applyArgvDeepLink,
  setInterviewSession,
  getCurrentInterviewUrl,
  getCurrentAccessToken,
};
