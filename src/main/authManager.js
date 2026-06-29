/**
 * src/main/authManager.js
 * ───────────────────────
 * Owns authentication against the LetsHyre API.
 *
 * SECURITY: the access/refresh tokens live ONLY in this main-process module —
 * they are never exposed to the renderer (which only ever sees non-sensitive
 * user fields like name/email/role). The renderer drives auth through IPC.
 *
 * Session-only: tokens are held in memory for the life of the app. There is no
 * refresh endpoint yet, so the user logs in once per launch.
 */

"use strict";

const axios = require("axios");
const logger = require("./logger");
const { API_BASE_URL, AUTH_LOGIN_PATH, AUTH_LOGOUT_PATH } = require("../shared/constants");

/** @type {{ accessToken: string, refreshToken: string, user: object } | null} */
let session = null;

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
      refreshToken: data.refresh_token,
      user: {
        id: data.id,
        name: data.name,
        username: data.username,
        email: data.email,
        role: data.role,
      },
    };

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
 * Logs out (best-effort server call) and clears the local session.
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
    // Clear locally even if the server call fails — the user wants to be logged out.
    logger.warn("[auth] logout request failed (clearing locally anyway):", err.message);
  }
  session = null;
  logger.info("[auth] logged out");
  return { success: true };
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

module.exports = { login, logout, getUser, getTokens, isAuthenticated };
