// Fetches the company's blocklist policy when an interview flow starts. Any
// failure keeps the built-in lists; the flow is never blocked on it.

"use strict";

const axios = require("axios");
const logger = require("./logger");
const { API_BASE_URL, PREFLIGHT_POLICY_PATH } = require("../shared/constants");
const blocklist = require("../shared/blocklist");
const { invalidateProcessCache } = require("../detector/mirrorDetector");

const REQUEST_TIMEOUT_MS = 5000;

const config = {
  path: PREFLIGHT_POLICY_PATH,
  get: (url, opts) => axios.get(url, opts),
};

let generation = 0;
let pending = null;

function setPolicy(policy) {
  const summary = policy ? blocklist.applyPolicy(policy) : blocklist.resetPolicy();
  invalidateProcessCache();
  return summary;
}

async function fetchPolicy(accessToken, startedIn) {
  try {
    const res = await config.get(`${API_BASE_URL}${config.path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (startedIn !== generation) {
      return;
    }
    const policy = blocklist.validatePolicy(res?.data);
    if (!policy) {
      logger.warn("[policy] response is not a valid policy — using built-in lists");
      setPolicy(null);
      return;
    }
    const { removed, added } = setPolicy(policy);
    logger.info(`[policy] applied: ${removed} allowed, ${added} added, ${policy.dropped} dropped`);
  } catch (err) {
    if (startedIn === generation) {
      logger.warn(`[policy] fetch failed — using built-in lists: ${err.message}`);
      setPolicy(null);
    }
  }
}

/**
 * Starts loading the policy for a new interview flow. Never rejects.
 * @param {string|null|undefined} accessToken
 * @returns {Promise<void>}
 */
function loadForInterview(accessToken) {
  generation += 1;
  setPolicy(null);
  if (!config.path || !accessToken) {
    pending = null;
    return Promise.resolve();
  }
  const promise = fetchPolicy(accessToken, generation).finally(() => {
    if (pending === promise) {
      pending = null;
    }
  });
  pending = promise;
  return promise;
}

/**
 * Waits for an in-flight fetch, at most `ms`, so a scan started right after
 * Start Interview uses the company's lists.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function whenSettled(ms) {
  if (!pending) {
    return Promise.resolve();
  }
  let timer;
  return Promise.race([
    pending,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Back to the built-in lists (logout, leaving the flow). */
function reset() {
  generation += 1;
  pending = null;
  if (blocklist.isPolicyApplied()) {
    logger.info("[policy] cleared");
  }
  setPolicy(null);
}

module.exports = {
  loadForInterview,
  whenSettled,
  reset,
  _config: config,
};
