/**
 * src/main/logger.js
 * ──────────────────
 * Structured logger for the main process — dual transport: console + file.
 *
 * Levels: debug < info < warn < error
 * Set LOG_LEVEL env variable to control verbosity (default: "info").
 *
 * File transport:
 *   Call logger.init(logDir) once after app.whenReady() to enable.
 *   Writes to <logDir>/secure-interview.log, auto-rotates at 5 MB.
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.init(app.getPath('userData'));   // in onReady()
 *   logger.info('[agent]', 'spawned');
 *   logger.warn('[agent]', 'not responding');
 *   logger.error('[violation]', 'API call failed', err.message);
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const LEVELS      = { debug: 0, info: 1, warn: 2, error: 3 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB — rotate at this size

/** @type {fs.WriteStream | null} */
let logStream = null;

/**
 * Initialises the file transport. Must be called after app.whenReady().
 * @param {string} logDir - Directory to write the log file into (typically app.getPath('userData')).
 */
function initFileLogger(logDir) {
  try {
    const logPath = path.join(logDir, "secure-interview.log");

    // Rotate if the existing log exceeds the size limit
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_BYTES) {
        const rotated = logPath.replace(".log", ".1.log");
        if (fs.existsSync(rotated)) { fs.unlinkSync(rotated); }
        fs.renameSync(logPath, rotated);
      }
    } catch {
      // File doesn't exist yet — that's fine
    }

    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("[logger] file stream error:", err.message);
      logStream = null;
    });

    log("info", `[logger] file transport active: ${logPath}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[logger] failed to init file transport:", err.message);
  }
}

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {...any} args
 */
function log(level, ...args) {
  if (LEVELS[level] < activeLevel) { return; }

  const ts     = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;

  // ── Console transport ────────────────────────────────────────
  // eslint-disable-next-line no-console
  console[level === "debug" || level === "info" ? "log" : level](prefix, ...args);

  // ── File transport (when initialised) ───────────────────────
  if (logStream) {
    const line = `${prefix} ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}\n`;
    logStream.write(line);
  }
}

const logger = {
  /**
   * Initialise the file transport. Call once after app.whenReady().
   * @type {(logDir: string) => void}
   */
  init: initFileLogger,

  debug: (...args) => log("debug", ...args),
  info:  (...args) => log("info",  ...args),
  warn:  (...args) => log("warn",  ...args),
  error: (...args) => log("error", ...args),
};

module.exports = logger;
