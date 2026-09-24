// Anonymous security-check results for the backend: counts, statuses and
// timings only. Never process names, paths or anything about the candidate.

"use strict";

const os = require("os");
const axios = require("axios");
const logger = require("./logger");
const { API_BASE_URL, PREFLIGHT_TELEMETRY_PATH } = require("../shared/constants");
const { isPolicyApplied } = require("../shared/blocklist");

const MAX_QUEUE = 20;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;

const TYPE_PATTERN = /^[a-z_]{1,40}$/;
const OUTCOMES = new Set(["ok", "timeout", "error"]);

function appVersion() {
  try {
    return require("electron").app.getVersion();
  } catch {
    return null;
  }
}

function locale() {
  try {
    return require("./localeManager").getPreferred();
  } catch {
    return null;
  }
}

function getToken() {
  try {
    return require("./protocolHandler").getCurrentAccessToken();
  } catch {
    return null;
  }
}

const config = {
  path: PREFLIGHT_TELEMETRY_PATH,
  post: (url, body, opts) => axios.post(url, body, opts),
  getToken,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
};

const shortString = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

function verdictEntry(v) {
  const entry = {
    id: shortString(v?.id, 20),
    status: shortString(v?.status, 20),
    reasonKey: shortString(v?.reasonKey, 80),
  };
  if (Array.isArray(v?.blockedApps)) {
    entry.blockedCount = v.blockedApps.length;
  }
  if (Array.isArray(v?.threats)) {
    entry.threatTypes = [
      ...new Set(v.threats.map((t) => t?.type).filter((t) => TYPE_PATTERN.test(t))),
    ].sort();
  }
  return entry;
}

function timingEntries(timings) {
  const out = {};
  for (const [probe, t] of Object.entries(timings || {})) {
    if (TYPE_PATTERN.test(probe)) {
      out[probe] = {
        durationMs: count(t?.durationMs),
        outcome: OUTCOMES.has(t?.outcome) ? t.outcome : null,
      };
    }
  }
  return out;
}

/**
 * The only shape that leaves the machine; every field is listed here.
 * @param {{scanId: string, capturedAt: number, canProceed: boolean, durationMs: number,
 *   verdicts: object[], timings: object, agentStatus?: object|null}} scan
 */
function buildPayload(scan) {
  const agent = scan?.agentStatus || null;
  return {
    scanId: shortString(scan?.scanId, 64),
    capturedAt: new Date(
      Number.isFinite(scan?.capturedAt) ? scan.capturedAt : Date.now()
    ).toISOString(),
    appVersion: appVersion(),
    agentVersion: shortString(agent?.agent_version, 40),
    agentSource: shortString(agent?.source_sha, 12),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    locale: shortString(locale(), 20),
    canProceed: scan?.canProceed === true,
    durationMs: count(scan?.durationMs),
    verdicts: (scan?.verdicts || []).map(verdictEntry),
    timings: timingEntries(scan?.timings),
    policyApplied: isPolicyApplied(),
  };
}

const queue = [];
let draining = null;

async function send(payload) {
  try {
    const token = config.getToken();
    if (!token) {
      return false;
    }
    await config.post(`${API_BASE_URL}${config.path}`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    logger.warn(`[telemetry] post failed: ${err.message}`);
    return false;
  }
}

function drain() {
  draining ??= drainQueue().finally(() => {
    draining = null;
  });
  return draining;
}

async function drainQueue() {
  while (queue.length > 0) {
    const item = queue[0];
    item.attempts += 1;
    const ok = await send(item.payload);
    if (ok || item.attempts >= MAX_ATTEMPTS) {
      if (!ok) {
        logger.warn(
          `[telemetry] dropped scan ${item.payload.scanId} after ${item.attempts} attempts`
        );
      }
      if (queue[0] === item) {
        queue.shift();
      }
      continue;
    }
    await config.sleep(BACKOFF_MS * 2 ** (item.attempts - 1));
  }
}

/**
 * Queues one committed scan for sending. Fire-and-forget; never throws.
 * @param {Parameters<typeof buildPayload>[0]} scan
 * @returns {Promise<void>} settles when the queue has drained (tests only)
 */
function recordScan(scan) {
  if (!config.path) {
    return Promise.resolve();
  }
  try {
    queue.push({ payload: buildPayload(scan), attempts: 0 });
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
    }
  } catch (err) {
    logger.warn(`[telemetry] could not record scan: ${err.message}`);
    return Promise.resolve();
  }
  return drain().catch((err) => logger.warn(`[telemetry] drain error: ${err.message}`));
}

module.exports = {
  recordScan,
  buildPayload,
  MAX_QUEUE,
  MAX_ATTEMPTS,
  _config: config,
  _queue: queue,
};
