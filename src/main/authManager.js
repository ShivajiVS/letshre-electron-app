/**
 * src/main/authManager.js
 * ───────────────────────
 * Owns authentication against the LetsHyre API.
 *
 * SECURITY: the access/refresh tokens live ONLY in this main-process module —
 * they are never exposed to the renderer (which only ever sees non-sensitive
 * user fields like name/email/role). The renderer drives auth through IPC.
 *
 * Persistence: on successful login the session is encrypted via Electron
 * safeStorage (DPAPI on Windows) and written to userData/session.enc.
 * On startup call authManager.init() (after app.whenReady) to restore it so
 * the user is not asked to log in again after closing and reopening the app.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { safeStorage, app } = require("electron");
const axios = require("axios");
const logger = require("./logger");
const {
  API_BASE_URL, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH,
  CANDIDATE_PROFILE_PATH, TOKEN_REFRESH_PATH,
} = require("../shared/constants");

/** @type {{ accessToken: string, refreshToken: string, user: object } | null} */
let session = null;

// ─── Session persistence ──────────────────────────────────────────────────────

function _sessionFilePath() {
  return path.join(app.getPath("userData"), "session.enc");
}

function _saveSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) { return; }
    const payload = JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user,
    });
    const encrypted = safeStorage.encryptString(payload);
    fs.writeFileSync(_sessionFilePath(), encrypted);
  } catch (err) {
    logger.warn("[auth] session persist failed:", err.message);
  }
}

function _clearPersistedSession() {
  try {
    const fp = _sessionFilePath();
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); }
  } catch { /* ignore */ }
}

/**
 * Restores a previously saved session from disk (encrypted via safeStorage).
 * Must be called after app.whenReady() — safeStorage is not available before.
 */
function init() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn("[auth] safeStorage unavailable — sessions will not persist across restarts");
      return;
    }
    const fp = _sessionFilePath();
    if (!fs.existsSync(fp)) { return; }
    const encrypted = fs.readFileSync(fp);
    const data = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(data);
    if (parsed?.accessToken && parsed?.user) {
      session = {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken || null,
        user: parsed.user,
      };
      logger.info("[auth] session restored for", session.user.email);
    }
  } catch (err) {
    logger.warn("[auth] session restore failed — will require re-login:", err.message);
    _clearPersistedSession();
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/**
 * Attempts a token refresh using the stored refresh token.
 * Updates `session.accessToken` (and refresh token if rotated) on success.
 * Clears the session (and persisted file) on failure — forces re-login.
 * @returns {Promise<boolean>}
 */
async function _refreshTokens() {
  if (!session?.refreshToken) { return false; }
  try {
    const res = await axios.post(
      `${API_BASE_URL}${TOKEN_REFRESH_PATH}`,
      { refresh_token: session.refreshToken },
      { timeout: 10000, headers: { "Content-Type": "application/json" } }
    );
    const body = res.data || {};
    const data = body.data || body;
    const newAccessToken = data.access_token || data.access || data.token;
    if (!newAccessToken) { return false; }
    session.accessToken = newAccessToken;
    const newRefresh = data.refresh_token || data.refresh;
    if (newRefresh) { session.refreshToken = newRefresh; }
    _saveSession(); // persist the rotated tokens
    logger.info("[auth] access token refreshed");
    return true;
  } catch (err) {
    logger.warn("[auth] token refresh failed — clearing session:", err.message);
    session = null;
    _clearPersistedSession();
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Logs in with email/password and stores the session in main.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, message: string, user?: object }>}
 */
async function login(email, password) {
  try {
    const res = await axios.post(
      `${API_BASE_URL}${AUTH_LOGIN_PATH}`,
      { email, password, role: "Candidate" },
      { timeout: 15000, headers: { "Content-Type": "application/json" } }
    );

    const body = res.data || {};
    const data = body.data || {};
    if (!body.success || !data.access_token) {
      return { success: false, message: body.message || "Login failed." };
    }

    // Keep tokens here; expose only display-safe fields to the renderer.
    session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      user: {
        id: data.id,
        name: data.name,
        username: data.username,
        email: data.email,
        role: data.role,
      },
    };

    _saveSession(); // persist across restarts
    logger.info("[auth] login success:", data.email);
    return { success: true, message: body.message || "Login successful.", user: session.user };
  } catch (err) {
    const message =
      err.response?.data?.message ||
      (err.response?.status ? `Login failed (HTTP ${err.response.status}).` : null) ||
      err.message ||
      "Login failed.";
    logger.warn("[auth] login failed:", message);
    return { success: false, message };
  }
}

/**
 * Logs out (best-effort server call) and clears the local + persisted session.
 * @returns {Promise<{ success: boolean }>}
 */
async function logout() {
  const refreshToken = session?.refreshToken;
  try {
    if (refreshToken) {
      await axios.post(
        `${API_BASE_URL}${AUTH_LOGOUT_PATH}`,
        { refresh_token: refreshToken },
        { timeout: 10000, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    logger.warn("[auth] logout request failed (clearing locally anyway):", err.message);
  }
  session = null;
  _clearPersistedSession();
  logger.info("[auth] logged out");
  return { success: true };
}

/**
 * Fetches the candidate profile from the API. Performs one automatic token
 * refresh on 401 before giving up. Never exposes tokens to the renderer.
 * @returns {Promise<{ success: boolean, data?: object, message?: string }>}
 */
async function getCandidateProfile() {
  if (!session?.accessToken) {
    return { success: false, message: "Not authenticated." };
  }

  const doRequest = () =>
    axios.get(`${API_BASE_URL}${CANDIDATE_PROFILE_PATH}`, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
    });

  try {
    const res = await doRequest();
    const body = res.data || {};
    return { success: true, data: body.data || {} };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          const body2 = res2.data || {};
          return { success: true, data: body2.data || {} };
        } catch (err2) {
          const msg = err2.response?.data?.message || err2.message || "Profile fetch failed after token refresh.";
          return { success: false, message: msg };
        }
      }
      return { success: false, message: "Session expired. Please log in again." };
    }
    const message = err.response?.data?.message || err.message || "Failed to load profile.";
    logger.warn("[auth] getCandidateProfile failed:", message);
    return { success: false, message };
  }
}

/** Display-safe user object for the renderer (no tokens). */
function getUser() {
  return session?.user || null;
}

/** Tokens for the interview hand-off (main-process use only). */
function getTokens() {
  if (!session) { return null; }
  return { accessToken: session.accessToken, refreshToken: session.refreshToken };
}

function isAuthenticated() {
  return session !== null;
}

module.exports = { init, login, logout, getUser, getTokens, isAuthenticated, getCandidateProfile };
