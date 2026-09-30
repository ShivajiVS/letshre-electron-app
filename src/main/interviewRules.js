// The limits the interview site publishes at /interview-rules.json, shown on the
// rules step so the candidate reads the numbers that will be enforced.

"use strict";

const axios = require("axios");
const logger = require("./logger");

const REQUEST_TIMEOUT_MS = 5000;
const LIMIT_KEYS = ["strikes", "faceInARow", "faceTotal", "disconnects", "heldSeconds"];

const config = {
  get: (url, opts) => axios.get(url, opts),
};

let _lastRules = null;

const isCount = (n) => Number.isInteger(n) && n > 0 && n <= 10_000;

/** @returns {object|null} only the known fields, or null when anything is off */
function validateRules(data) {
  if (!data || typeof data !== "object" || !isCount(data.version)) {
    return null;
  }
  const rules = { version: data.version };
  for (const key of LIMIT_KEYS) {
    if (!isCount(data[key])) {
      return null;
    }
    rules[key] = data[key];
  }
  return rules;
}

function rulesUrl(interviewUrl) {
  return new URL("/interview-rules.json", interviewUrl).toString();
}

/**
 * Never rejects. The result is remembered for acknowledgementFor().
 * @param {string} interviewUrl
 * @returns {Promise<{ok: true, rules: object} | {ok: false}>}
 */
async function fetchRules(interviewUrl) {
  _lastRules = null;
  try {
    const res = await config.get(rulesUrl(interviewUrl), { timeout: REQUEST_TIMEOUT_MS });
    const rules = validateRules(res?.data);
    if (!rules) {
      logger.warn("[rules] the site's interview-rules.json is not valid");
      return { ok: false };
    }
    _lastRules = rules;
    return { ok: true, rules };
  } catch (err) {
    logger.warn(`[rules] could not load the site's rules: ${err.message}`);
    return { ok: false };
  }
}

/**
 * What the site is told the candidate accepted. Built from the rules main
 * fetched, never from the renderer, so the site can trust the numbers.
 * @returns {object|null} null when the page showed the rules without numbers
 */
function acknowledgementFor(accepted, now = new Date()) {
  if (!accepted || !_lastRules) {
    return null;
  }
  return { ..._lastRules, at: now.toISOString() };
}

function reset() {
  _lastRules = null;
}

module.exports = {
  fetchRules,
  acknowledgementFor,
  validateRules,
  reset,
  _config: config,
};
