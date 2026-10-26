/**
 * Requests the interview site hands over so they still reach the backend when
 * the page can't send them itself:
 *
 *   - the finished proctoring log batch, sent as soon as it arrives;
 *   - the auto-submit the site started, held while the site is still trying
 *     and sent by the app only if the interview window closes first or the app
 *     is relaunched with it still pending.
 *
 * Main-process requests survive the window closing and need no CORS. Unsent
 * items are kept on disk (reportStore) and retried with backoff, including
 * after a relaunch. The backend accepts one log batch per interview, so the
 * site sends a batch itself only when this outbox isn't available.
 */

"use strict";

const crypto = require("crypto");
const axios = require("axios");
const { API_BASE_URL } = require("../shared/constants");
const reportStore = require("./reportStore");
const logger = require("./logger");

const PROCTORING_LOG_PATH = "/user/v1/candidate/interview/proctoring/log/";
const AUTO_SUBMIT_PATH = "/user/v1/candidate/interview/ai/auto_submit/force/";

const KIND = Object.freeze({ PROCTORING_LOG: "proctoring_log", AUTO_SUBMIT: "auto_submit" });

const MAX_ITEMS = 20;
// The whole queue is one sealed file, so one runaway batch can't be allowed to fill it.
const MAX_LOG_BYTES = 20 * 1024 * 1024;
// Older than this belongs to an interview long over, and the token behind it is gone.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const LOG_TIMEOUT_MS = 60000;
// Scoring runs inside the auto-submit request, so it gets longer than the log.
const SUBMIT_TIMEOUT_MS = 90000;

const ID_MAX = 100;

/** @type {Array<{id: string, kind: string, key: string, body: object, token: string|null, held: boolean, queuedAt: number}>} */
let items = [];
let flushing = false;
let retryTimer = null;
let retryDelayMs = RETRY_BASE_MS;

function _id(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX ? value : null;
}

function _token(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

// The site's own token is the freshest; after a relaunch only the restored login's is left.
function _mainToken() {
  try {
    const token = require("./protocolHandler").getCurrentAccessToken();
    if (token) {
      return token;
    }
  } catch {
    // fall through to the stored login
  }
  try {
    return require("./authManager").getTokens()?.accessToken ?? null;
  } catch {
    return null;
  }
}

function _save() {
  reportStore.save(items);
}

function _trim() {
  if (items.length > MAX_ITEMS) {
    const dropped = items.splice(0, items.length - MAX_ITEMS);
    logger.warn(`[outbox] queue full, dropped ${dropped.length} oldest item(s)`);
  }
}

/** Replaces any item with the same key, so a repeated hand-over is still one request. */
function _put(item) {
  items = items.filter((existing) => existing.key !== item.key);
  items.push(item);
  _trim();
  _save();
}

/**
 * Takes the site's finished proctoring log batch, exactly as it would have
 * POSTed it, and delivers it.
 * @param {object} batch
 * @param {string} [token] - the site's current access token
 * @returns {{ ok: boolean, error?: string }}
 */
function queueProctoringLog(batch, token) {
  const interviewId = _id(batch?.interview_id);
  const sessionId = _id(batch?.session_id);
  if (!interviewId || !sessionId || !Array.isArray(batch?.payload?.records)) {
    return { ok: false, error: "invalid batch" };
  }
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(batch));
  } catch {
    return { ok: false, error: "invalid batch" };
  }
  if (size > MAX_LOG_BYTES) {
    logger.warn(`[outbox] proctoring log refused: ${size} bytes`);
    return { ok: false, error: "batch too large" };
  }
  _put({
    id: crypto.randomUUID(),
    kind: KIND.PROCTORING_LOG,
    key: `log:${sessionId}`,
    body: batch,
    token: _token(token),
    held: false,
    queuedAt: Date.now(),
  });
  logger.info(
    `[outbox] proctoring log queued — session ${sessionId}, ${batch.payload.records.length} records, ${size} bytes`
  );
  flush().catch((err) => logger.warn(`[outbox] flush error: ${err.message}`));
  return { ok: true };
}

/**
 * The site started an auto-submit. Held, not sent: the site is sending it and
 * a second copy would race it. Sent only once the window closes or the app
 * restarts without the site having settled it.
 * @param {{ interviewId: string, sessionId: string, reason?: string, answer?: string }} submit
 * @param {string} [token]
 * @returns {{ ok: boolean, error?: string }}
 */
function holdSubmit(submit, token) {
  const interviewId = _id(submit?.interviewId);
  const sessionId = _id(submit?.sessionId);
  if (!interviewId || !sessionId) {
    return { ok: false, error: "invalid submit" };
  }
  const body = { interview_id: interviewId, session_id: sessionId };
  if (typeof submit.reason === "string" && submit.reason) {
    body.reason = submit.reason.slice(0, 64);
  }
  if (typeof submit.answer === "string" && submit.answer.trim()) {
    body.answer = submit.answer.slice(0, 100000);
  }
  _put({
    id: crypto.randomUUID(),
    kind: KIND.AUTO_SUBMIT,
    key: `submit:${sessionId}`,
    body,
    token: _token(token),
    held: true,
    queuedAt: Date.now(),
  });
  logger.info(`[outbox] auto-submit held for session ${sessionId} (${body.reason || "no reason"})`);
  return { ok: true };
}

/** The site's own auto-submit succeeded; the held copy is no longer owed. */
function settleSubmit(sessionId) {
  const key = `submit:${_id(sessionId)}`;
  const before = items.length;
  items = items.filter((item) => item.key !== key);
  if (items.length !== before) {
    _save();
    logger.info(`[outbox] auto-submit settled by the site for session ${sessionId}`);
  }
}

/**
 * The page that was sending the held auto-submits is gone, so they are the
 * app's to send now.
 * @param {string} why - for the log
 */
function releaseHeld(why) {
  let released = 0;
  for (const item of items) {
    if (item.held) {
      item.held = false;
      released += 1;
    }
  }
  if (released === 0) {
    return;
  }
  _save();
  logger.warn(`[outbox] ${released} unsettled auto-submit(s) taken over by the app — ${why}`);
  flush().catch((err) => logger.warn(`[outbox] flush error: ${err.message}`));
}

/**
 * Queues what a previous run left. Nothing from then is still being sent by a
 * page, so held auto-submits go out too. Call once the store is open.
 * @returns {number} how many were restored
 */
function restore() {
  const now = Date.now();
  const saved = reportStore
    .load()
    .filter((item) => item && Object.values(KIND).includes(item.kind) && item.body)
    .filter((item) => now - (item.queuedAt || 0) < MAX_AGE_MS);
  items = [...saved.map((item) => ({ ...item, held: false })), ...items];
  _trim();
  _save();
  if (saved.length > 0) {
    logger.info(`[outbox] ${saved.length} unsent item(s) from a previous run queued`);
    flush().catch((err) => logger.warn(`[outbox] flush error: ${err.message}`));
  }
  return saved.length;
}

/**
 * One attempt for one item.
 * @returns {Promise<"sent"|"retry"|"drop">}
 */
async function _post(item) {
  const token = item.token || _mainToken();
  if (!token) {
    return "retry";
  }
  const isLog = item.kind === KIND.PROCTORING_LOG;
  try {
    await axios.post(
      `${API_BASE_URL}${isLog ? PROCTORING_LOG_PATH : AUTO_SUBMIT_PATH}`,
      item.body,
      {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        timeout: isLog ? LOG_TIMEOUT_MS : SUBMIT_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    logger.info(`[outbox] ${item.kind} delivered (${item.key})`);
    return "sent";
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 && item.token) {
      // The site's token expired with the page; the app's own may still be good.
      item.token = null;
      _save();
      return "retry";
    }
    // A refused auto-submit is usually one the site's request already completed.
    if (status >= 400 && status < 500 && ![401, 408, 429].includes(status)) {
      logger.warn(`[outbox] backend refused ${item.kind} (${status}), dropping it (${item.key})`);
      return "drop";
    }
    logger.warn(`[outbox] ${item.kind} not delivered (will retry): ${status || err.message}`);
    return "retry";
  }
}

function _scheduleRetry() {
  if (retryTimer) {
    return;
  }
  const delay = retryDelayMs;
  retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flush().catch((err) => logger.warn(`[outbox] flush error: ${err.message}`));
  }, delay);
  retryTimer.unref?.();
}

/**
 * Sends every item that isn't held, oldest first. One that has to wait stops
 * the pass and schedules a backed-off retry. Re-entrancy guarded.
 */
async function flush() {
  if (flushing) {
    return;
  }
  flushing = true;
  try {
    for (;;) {
      const item = items.find((candidate) => !candidate.held);
      if (!item) {
        break;
      }
      const outcome = await _post(item);
      if (outcome === "retry") {
        _scheduleRetry();
        return;
      }
      // Removed by id: the queue can change while the request is in flight.
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index !== -1) {
        items.splice(index, 1);
        _save();
      }
    }
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelayMs = RETRY_BASE_MS;
  } finally {
    flushing = false;
  }
}

module.exports = {
  KIND,
  PROCTORING_LOG_PATH,
  AUTO_SUBMIT_PATH,
  queueProctoringLog,
  holdSubmit,
  settleSubmit,
  releaseHeld,
  restore,
  flush,
  _internal: {
    items: () => items.map((item) => ({ ...item })),
    reset() {
      items = [];
      flushing = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      retryDelayMs = RETRY_BASE_MS;
    },
  },
};
