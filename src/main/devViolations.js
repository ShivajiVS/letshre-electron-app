// Dev-only: fires any violation code through the real sendViolation path, so
// the interview site's handling can be tried without actually cheating.

"use strict";

const { isKnownCode } = require("../shared/violationCodes");

/**
 * @param {{enabled: boolean, getWindow: () => object|null, isSessionActive: () => boolean,
 *   sendViolation: Function, logger: object}} deps
 * @returns {(code: unknown) => {ok: boolean, error?: string}}
 */
function createViolationSimulator({ enabled, getWindow, isSessionActive, sendViolation, logger }) {
  return (code) => {
    if (!enabled) {
      logger.warn("[dev] simulated violation refused — DEVTOOLS is off");
      return { ok: false, error: "Not available in this build" };
    }
    if (!isKnownCode(code)) {
      return { ok: false, error: "Unknown violation code" };
    }
    const win = getWindow();
    if (!win || !isSessionActive()) {
      return { ok: false, error: "No interview is running" };
    }
    logger.info(`[dev] simulating violation: ${code}`);
    sendViolation(win, `Simulated violation (${code})`, "high", { code });
    return { ok: true };
  };
}

module.exports = { createViolationSimulator };
