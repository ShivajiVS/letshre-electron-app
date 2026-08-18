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
  VIDEO_UPLOAD_START_PATH, VIDEO_UPLOAD_CHUNK_PATH,
  VIDEO_UPLOAD_COMPLETE_PATH, VIDEO_UPLOAD_STATUS_PATH,
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

/**
 * Fetches an image URL in the main process (no CSP) and returns it as a
 * base64 data URL so the renderer can display it without CSP violations.
 * @param {string} url
 * @returns {Promise<{ ok: boolean, dataUrl?: string, error?: string }>}
 */
async function fetchProfileImage(url) {
  if (!url || typeof url !== "string") { return { ok: false, error: "No URL provided." }; }
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const contentType = res.headers["content-type"] || "image/jpeg";
    const base64 = Buffer.from(res.data).toString("base64");
    return { ok: true, dataUrl: `data:${contentType};base64,${base64}` };
  } catch (err) {
    logger.warn("[auth] fetchProfileImage failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Submits a voice sample blob to the API for identity verification.
 * Also sends the candidate's UI locale and the exact attestation text they
 * were shown, so backend STT/voice-match can use the right language model
 * instead of assuming English.
 * @param {Uint8Array} uint8Array
 * @param {string} mimeType
 * @param {{ locale?: string, statementText?: string }} [meta]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function submitVoiceSample(uint8Array, mimeType, meta = {}) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const safeLocale = typeof meta?.locale === "string" ? meta.locale.slice(0, 20) : undefined;
  const safeStatement = typeof meta?.statementText === "string" ? meta.statementText.slice(0, 500) : undefined;

  const doRequest = () => {
    const buf = Buffer.from(uint8Array);
    let ext = "webm";
    if (mimeType?.includes("mp4")) {ext = "mp4";}
    if (mimeType?.includes("ogg")) {ext = "ogg";}
    if (mimeType?.includes("wav")) {ext = "wav";}

    const form = new FormData();
    const blob = new Blob([buf], { type: mimeType || "audio/webm" });
    form.append("voice_sample", blob, `voice_sample.${ext}`);
    if (safeLocale) {form.append("locale", safeLocale);}
    if (safeStatement) {form.append("statement_text", safeStatement);}

    return axios.post(
      `${API_BASE_URL}/user/v1/candidate/interview/voice_sample/`,
      form,
      { timeout: 30000, headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
  };

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try { await doRequest(); return { ok: true }; } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Voice submission failed." };
  }
}

/**
 * Submits a captured photo (data URL) to the face verification API.
 * @param {string} dataUrl  — canvas toDataURL result
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
async function submitFaceVerification(dataUrl) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () => {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    const form = new FormData();
    const blob = new Blob([buf], { type: "image/jpeg" });
    form.append("live_photo", blob, "photo.jpg");

    return axios.post(
      `${API_BASE_URL}/user/v1/candidate/interview/face_verification/`,
      form,
      { timeout: 30000, headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
  };

  try {
    const res = await doRequest();
    return { ok: true, data: res.data?.data || res.data };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          return { ok: true, data: res2.data?.data || res2.data };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Face verification failed." };
  }
}

/**
 * Submits a role string to the skills-for-role API.
 * @param {string} role
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
async function submitRole(role) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () =>
    axios.post(
      `${API_BASE_URL}/user/v1/candidate_resume_ai/skills_for_role/`,
      { role },
      { timeout: 20000, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` } }
    );

  try {
    const res = await doRequest();
    return { ok: true, data: res.data?.data || res.data };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          return { ok: true, data: res2.data?.data || res2.data };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Role submission failed." };
  }
}

/**
 * Verifies the restored session against the API on startup.
 * Tries the access token; on 401 attempts a refresh; on network error
 * grants offline grace so the user isn't forced to log in without connectivity.
 *
 * @returns {Promise<{ valid: boolean, offline?: boolean, reason?: string }>}
 */
async function verifySession() {
  if (!session?.accessToken) {
    return { valid: false, reason: "no-session" };
  }

  try {
    await axios.get(`${API_BASE_URL}${CANDIDATE_PROFILE_PATH}`, {
      timeout: 8000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    logger.info("[auth] session verified on startup");
    return { valid: true };
  } catch (err) {
    if (err.response?.status === 401) {
      logger.info("[auth] access token expired on startup — attempting refresh");
      const refreshed = await _refreshTokens();
      if (refreshed) {
        logger.info("[auth] tokens refreshed successfully on startup");
        return { valid: true };
      }
      logger.warn("[auth] refresh failed on startup — user must re-login");
      return { valid: false, reason: "expired" };
    }
    // No response = network unreachable — grant offline grace rather than
    // forcing re-login when the user is clearly already authenticated.
    logger.warn("[auth] verifySession: network unreachable — allowing offline startup");
    return { valid: true, offline: true };
  }
}

// ─── Screen-recording upload API ─────────────────────────────────────────────
// Mirrors videoUpload.api.js from the interview site. All calls are
// authenticated via the main-process Bearer token — tokens never touch the
// renderer. Each function applies the same 401 → refresh → retry pattern used
// throughout this module.

/**
 * Registers a new upload session with the backend.
 * Must be called before any chunk uploads.
 * @param {{ interviewId: string, fileName: string }} opts
 * @returns {Promise<{ ok: boolean, uploadId?: string, error?: string }>}
 */
async function startVideoUpload({ interviewId, fileName }) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () => axios.post(
    `${API_BASE_URL}${VIDEO_UPLOAD_START_PATH}`,
    { interview_id: interviewId, file_name: fileName, content_type: "video/webm" },
    { timeout: 20000, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` } }
  );

  try {
    const res = await doRequest();
    const uploadId = res.data?.data?.upload_id || res.data?.upload_id || null;
    if (!uploadId) { return { ok: false, error: "No upload_id in response." }; }
    return { ok: true, uploadId };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          const uploadId = res2.data?.data?.upload_id || res2.data?.upload_id || null;
          return uploadId ? { ok: true, uploadId } : { ok: false, error: "No upload_id in response." };
        } catch (e2) { return { ok: false, error: e2.response?.data?.message || e2.message }; }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Start upload failed." };
  }
}

/**
 * Uploads one independently-decodable WebM chunk.
 * The chunk MUST be a complete initSegment + Clusters blob (produced by
 * webmChunker) — raw MediaRecorder timeslices are not valid here.
 *
 * @param {{ uploadId: string, chunkIndex: number, chunk: Uint8Array }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function uploadVideoChunk({ uploadId, chunkIndex, chunk }) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () => {
    const form = new FormData();
    form.append("upload_id",   uploadId);
    form.append("chunk_index", String(chunkIndex));
    form.append("chunk", new Blob([Buffer.from(chunk)], { type: "video/webm" }), `chunk_${chunkIndex}.webm`);
    return axios.post(
      `${API_BASE_URL}${VIDEO_UPLOAD_CHUNK_PATH}`,
      form,
      { timeout: 60000, headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
  };

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try { await doRequest(); return { ok: true }; } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Chunk upload failed." };
  }
}

/**
 * Signals the backend that all chunks have been uploaded.
 * The backend responds with 202 and queues an ffmpeg merge job.
 * @param {string} uploadId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function completeVideoUpload(uploadId) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () => axios.post(
    `${API_BASE_URL}${VIDEO_UPLOAD_COMPLETE_PATH}`,
    { upload_id: uploadId },
    { timeout: 20000, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` } }
  );

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try { await doRequest(); return { ok: true }; } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Complete upload failed." };
  }
}

/**
 * Polls the merge status of a completed upload.
 * @param {string} uploadId
 * @returns {Promise<{ ok: boolean, status?: string, videoUrl?: string, error?: string }>}
 */
async function getVideoUploadStatus(uploadId) {
  if (!session?.accessToken) { return { ok: false, error: "Not authenticated." }; }

  const doRequest = () => axios.get(
    `${API_BASE_URL}${VIDEO_UPLOAD_STATUS_PATH}${uploadId}/`,
    { timeout: 15000, headers: { Authorization: `Bearer ${session.accessToken}` } }
  );

  try {
    const res = await doRequest();
    const data = res.data?.data || res.data || {};
    return { ok: true, status: data.status || null, videoUrl: data.interview?.video_url || null };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          const data2 = res2.data?.data || res2.data || {};
          return { ok: true, status: data2.status || null, videoUrl: data2.interview?.video_url || null };
        } catch (e2) { return { ok: false, error: e2.response?.data?.message || e2.message }; }
      }
      return { ok: false, error: "Session expired." };
    }
    return { ok: false, error: err.response?.data?.message || err.message || "Status check failed." };
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

module.exports = {
  init, verifySession, login, logout, getUser, getTokens, isAuthenticated,
  getCandidateProfile, fetchProfileImage, submitVoiceSample, submitFaceVerification, submitRole,
  startVideoUpload, uploadVideoChunk, completeVideoUpload, getVideoUploadStatus,
};
