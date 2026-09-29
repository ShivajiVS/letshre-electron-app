/**
 * A short code a candidate can quote to support, e.g. LH-7KQ2-M4XD. It comes
 * from the interview's session id once the site has started proctoring, and
 * from a random id for this attempt before that, and is logged whenever it
 * changes so support can find the right logs.
 */

"use strict";

const crypto = require("crypto");
const logger = require("./logger");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_PATTERN = /^LH-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

let _runId = crypto.randomUUID();
let _sessionId = null;

/** Uppercase base32 of the first 40 bits of the seed's SHA-256, as LH-XXXX-XXXX. */
function referenceCodeFor(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed)).digest().subarray(0, 5);
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let chars = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) {
    chars += BASE32[Number((bits >> shift) & 31n)];
  }
  return `LH-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function currentCode() {
  return referenceCodeFor(_sessionId ?? _runId);
}

/** A new attempt from the dashboard gets its own code. */
function startRun() {
  _runId = crypto.randomUUID();
  _sessionId = null;
  logger.info(`[support] reference ${currentCode()} for this attempt`);
}

/** @param {string|null} sessionId - from PROCTORING_START */
function rememberSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId === _sessionId) {
    return;
  }
  _sessionId = sessionId;
  logger.info(`[support] reference ${currentCode()} for session ${sessionId}`);
}

module.exports = { referenceCodeFor, currentCode, startRun, rememberSession, CODE_PATTERN };
