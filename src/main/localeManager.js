/**
 * src/main/localeManager.js
 * ──────────────────────────
 * Resolves, reads, and persists the candidate's UI language.
 *
 * Translation bundles are static JSON files under assets/locales/ — read here
 * (main process) and handed to renderers over IPC, mirroring how windowManager
 * loads assets/*.html. This avoids file:// fetch + CSP friction in the
 * sandboxed renderer and keeps the asar-safe path resolution in one place.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const logger = require("./logger");
const { SUPPORTED_LOCALES, DEFAULT_LOCALE } = require("../shared/constants");

const SUPPORTED_CODES = new Set(SUPPORTED_LOCALES.map((l) => l.code));

/** @type {Map<string, object>} in-memory cache of parsed bundles */
const _bundleCache = new Map();

/** @type {string | null} */
let _preferred = null;

function _localesDir() {
  return path.join(__dirname, "../../assets/locales");
}

function _prefsFilePath() {
  return path.join(app.getPath("userData"), "preferences.json");
}

/** Maps an OS locale string (e.g. "hi-IN", "zh-Hans-CN") to a supported code. */
function _matchOSLocale(osLocale) {
  if (!osLocale) {return null;}
  if (SUPPORTED_CODES.has(osLocale)) {return osLocale;}
  const lower = osLocale.toLowerCase();
  for (const code of SUPPORTED_CODES) {
    if (lower === code.toLowerCase()) {return code;}
  }
  // Fall back to matching just the primary subtag (e.g. "hi" from "hi-IN").
  const primary = lower.split("-")[0];
  for (const code of SUPPORTED_CODES) {
    if (code.toLowerCase().split("-")[0] === primary) {return code;}
  }
  return null;
}

/** Resolves the initial locale from the OS when no stored preference exists. */
function resolveInitialLocale() {
  try {
    const osLocale = app.getLocale(); // e.g. "en-US", "hi-IN"
    const matched = _matchOSLocale(osLocale);
    if (matched) {
      logger.info(`[locale] resolved OS locale "${osLocale}" -> "${matched}"`);
      return matched;
    }
    logger.info(`[locale] OS locale "${osLocale}" unsupported — defaulting to ${DEFAULT_LOCALE}`);
  } catch (err) {
    logger.warn("[locale] resolveInitialLocale failed:", err.message);
  }
  return DEFAULT_LOCALE;
}

function _loadPreferenceFromDisk() {
  try {
    const fp = _prefsFilePath();
    if (!fs.existsSync(fp)) {return null;}
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.locale === "string" && SUPPORTED_CODES.has(parsed.locale)) {
      return parsed.locale;
    }
  } catch (err) {
    logger.warn("[locale] preference read failed:", err.message);
  }
  return null;
}

/** Returns the active locale: stored preference, else OS-resolved default. */
function getPreferred() {
  if (_preferred) {return _preferred;}
  const stored = _loadPreferenceFromDisk();
  _preferred = stored || resolveInitialLocale();
  return _preferred;
}

/** Persists the candidate's chosen locale (survives app restarts). */
function setPreferred(locale) {
  const safe = SUPPORTED_CODES.has(locale) ? locale : DEFAULT_LOCALE;
  _preferred = safe;
  try {
    fs.writeFileSync(_prefsFilePath(), JSON.stringify({ locale: safe }), "utf8");
  } catch (err) {
    logger.warn("[locale] preference persist failed:", err.message);
  }
  return safe;
}

/**
 * Reads and caches a translation bundle from disk.
 * Falls back to English if the requested locale file is missing/invalid.
 * @param {string} locale
 * @returns {object}
 */
function getTranslations(locale) {
  const code = SUPPORTED_CODES.has(locale) ? locale : DEFAULT_LOCALE;
  if (_bundleCache.has(code)) {return _bundleCache.get(code);}

  try {
    const fp = path.join(_localesDir(), `${code}.json`);
    const raw = fs.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw);
    _bundleCache.set(code, parsed);
    return parsed;
  } catch (err) {
    logger.warn(`[locale] failed to load bundle "${code}", falling back to ${DEFAULT_LOCALE}:`, err.message);
    if (code !== DEFAULT_LOCALE) {return getTranslations(DEFAULT_LOCALE);}
    return {};
  }
}

function getSupportedLocales() {
  return SUPPORTED_LOCALES;
}

module.exports = {
  resolveInitialLocale,
  getPreferred,
  setPreferred,
  getTranslations,
  getSupportedLocales,
};
