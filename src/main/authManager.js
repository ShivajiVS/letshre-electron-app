/**

 * Owns authentication against the LetsHyre API.
 * Tokens live ONLY here — the renderer never sees them, only display-safe
 * user fields (name/email/role), and drives auth through IPC.
 *
 * Sessions persist via Electron safeStorage (DPAPI on Windows) to
 * userData/session.enc. Call init() after app.whenReady to restore one so
 * the user isn't re-prompted to log in on relaunch.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { safeStorage, app } = require("electron");
const axios = require("axios");
const logger = require("./logger");
const {
  API_BASE_URL,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  CANDIDATE_PROFILE_PATH,
  TOKEN_REFRESH_PATH,
  VIDEO_UPLOAD_START_PATH,
  VIDEO_UPLOAD_CHUNK_PATH,
  VIDEO_UPLOAD_COMPLETE_PATH,
  VIDEO_UPLOAD_STATUS_PATH,
} = require("../shared/constants");

/** @type {{ accessToken: string, refreshToken: string, user: object } | null} */
let session = null;

/**
 * Stable, backend-independent failure codes for login(). The renderer maps
 * each to a localized string via window.t() — the server's own `message`
 * field is diagnostic-only (logged, never shown) so UI copy never depends on
 * backend wording or language.
 */
const AUTH_ERROR = {
  INVALID_CREDENTIALS: "invalid_credentials",
  MISSING_FIELDS: "missing_fields",
  INVALID_EMAIL: "invalid_email",
  ACCOUNT_INACTIVE: "account_inactive",
  WRONG_ROLE: "wrong_role",
  RATE_LIMITED: "rate_limited",
  SERVER_ERROR: "server_error",
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  MALFORMED_RESPONSE: "malformed_response",
  UNKNOWN: "unknown",
};

/** This app is candidate-only; any other role must be blocked, not silently let in. */
const EXPECTED_ROLE = "Candidate";

// Env-overridable so the value can be tuned against real timings without a
// rebuild. Left at 60s deliberately: chunk uploads have been observed burning
// the whole budget and then succeeding on retry, and lowering the ceiling
// before that stall is understood would convert slow-but-working uploads into
// failing ones.
const CHUNK_UPLOAD_TIMEOUT_MS = Number(process.env.CHUNK_UPLOAD_TIMEOUT_MS) || 60000;

/**
 * Classifies a failed axios call against the login endpoint into a stable
 * AUTH_ERROR code. Never returns the server's raw message text — only a code
 * plus (for rate limiting) a numeric retry hint.
 * @param {import("axios").AxiosError} err
 * @returns {{ code: string, retryAfterSeconds?: number }}
 */
function _classifyLoginError(err) {
  if (err.code === "ECONNABORTED") {
    return { code: AUTH_ERROR.TIMEOUT };
  }
  const status = err.response?.status;
  if (!status) {
    // No response at all — DNS failure, connection refused, offline. Never
    // surface err.message here: it's a raw Node/axios string ("getaddrinfo
    // ENOTFOUND ...") that leaks internal detail to the candidate's screen.
    return { code: AUTH_ERROR.NETWORK_ERROR };
  }
  if (status === 429) {
    const raw = err.response.headers?.["retry-after"];
    const seconds = Number(raw);
    return {
      code: AUTH_ERROR.RATE_LIMITED,
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    };
  }
  if (status >= 500) {
    return { code: AUTH_ERROR.SERVER_ERROR };
  }
  // 400/401/422 etc. — the documented shape for bad credentials. Some backends
  // answer this with success:false + 200 instead; that path is handled in
  // login() itself, not here.
  return { code: AUTH_ERROR.INVALID_CREDENTIALS };
}

/**
 * Stable failure codes for the post-login API calls below (voice/photo/role
 * submission) — same rationale as AUTH_ERROR/_classifyLoginError: never hand
 * the renderer a raw backend `message` or axios error string, so UI copy
 * stays locale-consistent regardless of server wording.
 */
const API_ERROR = {
  SESSION_EXPIRED: "session_expired",
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  SERVER_ERROR: "server_error",
  REQUEST_FAILED: "request_failed",
  UNKNOWN: "unknown",
};

/**
 * Classifies a failed axios call (outside the login flow) into a stable
 * API_ERROR code, for logging the real message here and returning only the
 * code to the renderer.
 * @param {import("axios").AxiosError} err
 * @returns {string}
 */
function _classifyApiError(err) {
  if (err.code === "ECONNABORTED") {
    return API_ERROR.TIMEOUT;
  }
  const status = err.response?.status;
  if (!status) {
    return API_ERROR.NETWORK_ERROR;
  }
  if (status >= 500) {
    return API_ERROR.SERVER_ERROR;
  }
  return API_ERROR.REQUEST_FAILED;
}

function _sessionFilePath() {
  return path.join(app.getPath("userData"), "session.enc");
}

function _saveSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }
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
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  } catch {
    /* ignore */
  }
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
    if (!fs.existsSync(fp)) {
      return;
    }
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

/**
 * Attempts a token refresh using the stored refresh token.
 * Updates `session.accessToken` (and refresh token if rotated) on success.
 * Clears the session (and persisted file) on failure — forces re-login.
 * @returns {Promise<boolean>}
 */
async function _refreshTokens() {
  if (!session?.refreshToken) {
    return false;
  }
  try {
    const res = await axios.post(
      `${API_BASE_URL}${TOKEN_REFRESH_PATH}`,
      { refresh_token: session.refreshToken },
      { timeout: 10000, headers: { "Content-Type": "application/json" } }
    );
    const body = res.data || {};
    const data = body.data || body;
    const newAccessToken = data.access_token || data.access || data.token;
    if (!newAccessToken) {
      return false;
    }
    session.accessToken = newAccessToken;
    const newRefresh = data.refresh_token || data.refresh;
    if (newRefresh) {
      session.refreshToken = newRefresh;
    }
    _saveSession();
    logger.info("[auth] access token refreshed");
    return true;
  } catch (err) {
    logger.warn("[auth] token refresh failed — clearing session:", err.message);
    session = null;
    _clearPersistedSession();
    return false;
  }
}

/**
 * Logs in with email/password and stores the session in main.
 *
 * Never returns the backend's free-text `message` — only a stable `code` (see
 * AUTH_ERROR) that the renderer maps to a localized string. The server's
 * message is logged for diagnostics only.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, code?: string, retryAfterSeconds?: number, user?: object }>}
 */
async function login(email, password) {
  let res;
  try {
    res = await axios.post(
      `${API_BASE_URL}${AUTH_LOGIN_PATH}`,
      { email, password, role: EXPECTED_ROLE },
      { timeout: 15000, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const { code, retryAfterSeconds } = _classifyLoginError(err);
    logger.warn(
      `[auth] login failed for ${email}: code=${code} status=${err.response?.status ?? "n/a"} ` +
        `server-message=${JSON.stringify(err.response?.data?.message)}`
    );
    return { success: false, code, retryAfterSeconds };
  }

  const body = res.data || {};
  const data = body.data || {};

  // Some backends answer bad credentials with 200 + success:false instead of
  // a 4xx status — both transport shapes are documented as possible, so both
  // are handled. body.message is logged only, never returned to the renderer.
  if (!body.success) {
    logger.warn(
      `[auth] login rejected for ${email}: server-message=${JSON.stringify(body.message)}`
    );
    return { success: false, code: AUTH_ERROR.INVALID_CREDENTIALS };
  }

  if (!data.access_token || !data.id || !data.email) {
    logger.warn(`[auth] login response missing required fields for ${email}`);
    return { success: false, code: AUTH_ERROR.MALFORMED_RESPONSE };
  }

  if (data.is_active === false) {
    logger.warn(`[auth] login blocked — account inactive: ${email}`);
    return { success: false, code: AUTH_ERROR.ACCOUNT_INACTIVE };
  }

  if (data.role !== EXPECTED_ROLE) {
    logger.warn(`[auth] login blocked — unexpected role "${data.role}" for ${email}`);
    return { success: false, code: AUTH_ERROR.WRONG_ROLE };
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

  _saveSession();
  logger.info("[auth] login success:", data.email);
  return { success: true, user: session.user };
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
          const msg =
            err2.response?.data?.message ||
            err2.message ||
            "Profile fetch failed after token refresh.";
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
  if (!url || typeof url !== "string") {
    return { ok: false, error: "No URL provided." };
  }
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
 * Also sends UI locale + attestation text so backend STT/voice-match picks
 * the right language model instead of assuming English.
 * @param {Uint8Array} uint8Array
 * @param {string} mimeType
 * @param {{ locale?: string, statementText?: string }} [meta]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function submitVoiceSample(uint8Array, mimeType, meta = {}) {
  if (!session?.accessToken) {
    return { ok: false, code: API_ERROR.SESSION_EXPIRED };
  }

  const safeLocale = typeof meta?.locale === "string" ? meta.locale.slice(0, 20) : undefined;
  const safeStatement =
    typeof meta?.statementText === "string" ? meta.statementText.slice(0, 500) : undefined;

  const doRequest = () => {
    const buf = Buffer.from(uint8Array);
    let ext = "webm";
    if (mimeType?.includes("mp4")) {
      ext = "mp4";
    }
    if (mimeType?.includes("ogg")) {
      ext = "ogg";
    }
    if (mimeType?.includes("wav")) {
      ext = "wav";
    }

    const form = new FormData();
    const blob = new Blob([buf], { type: mimeType || "audio/webm" });
    form.append("voice_sample", blob, `voice_sample.${ext}`);
    if (safeLocale) {
      form.append("locale", safeLocale);
    }
    if (safeStatement) {
      form.append("statement_text", safeStatement);
    }

    return axios.post(`${API_BASE_URL}/user/v1/candidate/interview/voice_sample/`, form, {
      timeout: 30000,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  };

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          await doRequest();
          return { ok: true };
        } catch (e2) {
          logger.warn(
            "[auth] submitVoiceSample retry failed:",
            e2.response?.data?.message || e2.message
          );
          return { ok: false, code: _classifyApiError(e2) };
        }
      }
      return { ok: false, code: API_ERROR.SESSION_EXPIRED };
    }
    logger.warn("[auth] submitVoiceSample failed:", err.response?.data?.message || err.message);
    return { ok: false, code: _classifyApiError(err) };
  }
}

/**
 * Submits a captured photo (data URL) to the face verification API.
 * @param {string} dataUrl  — canvas toDataURL result
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
async function submitFaceVerification(dataUrl) {
  if (!session?.accessToken) {
    return { ok: false, code: API_ERROR.SESSION_EXPIRED };
  }

  const doRequest = () => {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    const form = new FormData();
    const blob = new Blob([buf], { type: "image/jpeg" });
    form.append("live_photo", blob, "photo.jpg");

    return axios.post(`${API_BASE_URL}/user/v1/candidate/interview/face_verification/`, form, {
      timeout: 30000,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
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
          logger.warn(
            "[auth] submitFaceVerification retry failed:",
            e2.response?.data?.message || e2.message
          );
          return { ok: false, code: _classifyApiError(e2) };
        }
      }
      return { ok: false, code: API_ERROR.SESSION_EXPIRED };
    }
    logger.warn(
      "[auth] submitFaceVerification failed:",
      err.response?.data?.message || err.message
    );
    return { ok: false, code: _classifyApiError(err) };
  }
}

/**
 * Submits a role string to the skills-for-role API.
 * @param {string} role
 * @returns {Promise<{ ok: boolean, data?: object, error?: string }>}
 */
async function submitRole(role) {
  if (!session?.accessToken) {
    return { ok: false, code: API_ERROR.SESSION_EXPIRED };
  }

  const doRequest = () =>
    axios.post(
      `${API_BASE_URL}/user/v1/candidate_resume_ai/skills_for_role/`,
      { role },
      {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
      }
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
          logger.warn("[auth] submitRole retry failed:", e2.response?.data?.message || e2.message);
          return { ok: false, code: _classifyApiError(e2) };
        }
      }
      return { ok: false, code: API_ERROR.SESSION_EXPIRED };
    }
    logger.warn("[auth] submitRole failed:", err.response?.data?.message || err.message);
    return { ok: false, code: _classifyApiError(err) };
  }
}

/**
 * Verifies the restored session against the API on startup: tries the
 * access token, refreshes on 401, and grants offline grace on network
 * error so connectivity loss doesn't force a re-login.
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

// ─── Screen-recording upload API
// Mirrors videoUpload.api.js from the interview site. Same 401 → refresh →
// retry pattern as the rest of this module; tokens never leave main.

/**
 * Registers a new upload session with the backend.
 * Must be called before any chunk uploads.
 * @param {{ interviewId: string, fileName: string }} opts
 * @returns {Promise<{ ok: boolean, uploadId?: string, error?: string }>}
 */
async function startVideoUpload({ interviewId, fileName }) {
  if (!session?.accessToken) {
    return { ok: false, error: "Not authenticated." };
  }

  const doRequest = () =>
    axios.post(
      `${API_BASE_URL}${VIDEO_UPLOAD_START_PATH}`,
      { interview_id: interviewId, file_name: fileName, content_type: "video/webm" },
      {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
      }
    );

  try {
    const res = await doRequest();
    const uploadId = res.data?.data?.upload_id || res.data?.upload_id || null;
    if (!uploadId) {
      return { ok: false, error: "No upload_id in response." };
    }
    return { ok: true, uploadId };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          const res2 = await doRequest();
          const uploadId = res2.data?.data?.upload_id || res2.data?.upload_id || null;
          return uploadId
            ? { ok: true, uploadId }
            : { ok: false, error: "No upload_id in response." };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return {
      ok: false,
      error: err.response?.data?.message || err.message || "Start upload failed.",
    };
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
  if (!session?.accessToken) {
    return { ok: false, error: "Not authenticated." };
  }

  const doRequest = () => {
    const form = new FormData();
    form.append("upload_id", uploadId);
    form.append("chunk_index", String(chunkIndex));
    form.append(
      "chunk",
      new Blob([Buffer.from(chunk)], { type: "video/webm" }),
      `chunk_${chunkIndex}.webm`
    );
    // Timings are logged per attempt because chunk uploads stall in a way that
    // is invisible from the outcome alone — a chunk that eventually succeeds
    // after burning the full timeout looks identical in the logs to a fast one.
    // sentAt vs settled tells connect-and-send apart from waiting on a reply.
    const sentAt = Date.now();
    return axios
      .post(`${API_BASE_URL}${VIDEO_UPLOAD_CHUNK_PATH}`, form, {
        timeout: CHUNK_UPLOAD_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
      .then((res) => {
        logger.info(
          `[upload] chunk ${chunkIndex} ok in ${Date.now() - sentAt}ms (${chunk.byteLength} B)`
        );
        return res;
      })
      .catch((err) => {
        logger.warn(
          `[upload] chunk ${chunkIndex} failed after ${Date.now() - sentAt}ms (${chunk.byteLength} B) — ${err.code || err.message}`
        );
        throw err;
      });
  };

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          await doRequest();
          return { ok: true };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return {
      ok: false,
      error: err.response?.data?.message || err.message || "Chunk upload failed.",
    };
  }
}

/**
 * Signals the backend that all chunks have been uploaded.
 * The backend responds with 202 and queues an ffmpeg merge job.
 * @param {string} uploadId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function completeVideoUpload(uploadId) {
  if (!session?.accessToken) {
    return { ok: false, error: "Not authenticated." };
  }

  const doRequest = () =>
    axios.post(
      `${API_BASE_URL}${VIDEO_UPLOAD_COMPLETE_PATH}`,
      { upload_id: uploadId },
      {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessToken}`,
        },
      }
    );

  try {
    await doRequest();
    return { ok: true };
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await _refreshTokens();
      if (refreshed) {
        try {
          await doRequest();
          return { ok: true };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return {
      ok: false,
      error: err.response?.data?.message || err.message || "Complete upload failed.",
    };
  }
}

/**
 * Polls the merge status of a completed upload.
 * @param {string} uploadId
 * @returns {Promise<{ ok: boolean, status?: string, videoUrl?: string, error?: string }>}
 */
async function getVideoUploadStatus(uploadId) {
  if (!session?.accessToken) {
    return { ok: false, error: "Not authenticated." };
  }

  const doRequest = () =>
    axios.get(`${API_BASE_URL}${VIDEO_UPLOAD_STATUS_PATH}${uploadId}/`, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

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
          return {
            ok: true,
            status: data2.status || null,
            videoUrl: data2.interview?.video_url || null,
          };
        } catch (e2) {
          return { ok: false, error: e2.response?.data?.message || e2.message };
        }
      }
      return { ok: false, error: "Session expired." };
    }
    return {
      ok: false,
      error: err.response?.data?.message || err.message || "Status check failed.",
    };
  }
}

/** Display-safe user object for the renderer (no tokens). */
function getUser() {
  return session?.user || null;
}

/** Tokens for the interview hand-off (main-process use only). */
function getTokens() {
  if (!session) {
    return null;
  }
  return { accessToken: session.accessToken, refreshToken: session.refreshToken };
}

module.exports = {
  AUTH_ERROR,
  API_ERROR,
  init,
  verifySession,
  login,
  logout,
  getUser,
  getTokens,
  getCandidateProfile,
  fetchProfileImage,
  submitVoiceSample,
  submitFaceVerification,
  submitRole,
  startVideoUpload,
  uploadVideoChunk,
  completeVideoUpload,
  getVideoUploadStatus,
};
