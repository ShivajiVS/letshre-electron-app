/**
 * src/main/logger.js
 * ──────────────────
 * Minimal structured logger for the main process.
 *
 * Levels: debug < info < warn < error
 * Set LOG_LEVEL env variable to control verbosity (default: "info").
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('[agent]', 'spawned from', agentPath);
 *   logger.warn('[agent]', 'not responding — continuing without deep detection');
 *   logger.error('[violation]', 'API call failed', err.message);
 */

"use strict";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {...any} args
 */
function log(level, ...args) {
  if (LEVELS[level] < activeLevel) {return;}
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  console[level === "debug" || level === "info" ? "log" : level](prefix, ...args);
}

const logger = {
  debug: (...args) => log("debug", ...args),
  info: (...args) => log("info", ...args),
  warn: (...args) => log("warn", ...args),
  error: (...args) => log("error", ...args),
};

module.exports = logger;
