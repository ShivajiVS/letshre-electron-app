/**
 * Resolves, reads, and persists the candidate's UI language.
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
  if (!osLocale) {
    return null;
  }
  if (SUPPORTED_CODES.has(osLocale)) {
    return osLocale;
  }
  const lower = osLocale.toLowerCase();
  for (const code of SUPPORTED_CODES) {
    if (lower === code.toLowerCase()) {
      return code;
    }
  }
  // Fall back to matching just the primary subtag (e.g. "hi" from "hi-IN").
  const primary = lower.split("-")[0];
  for (const code of SUPPORTED_CODES) {
    if (code.toLowerCase().split("-")[0] === primary) {
      return code;
    }
  }
  return null;
}

/** Resolves the initial locale from the OS when no stored preference exists. */
function resolveInitialLocale() {
  try {
    const osLocale = app.getLocale();
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
    if (!fs.existsSync(fp)) {
      return null;
    }
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
  if (_preferred) {
    return _preferred;
  }
  const stored = _loadPreferenceFromDisk();
  _preferred = stored || resolveInitialLocale();
  return _preferred;
}

/** Reads preferences.json as an object, tolerating a missing/corrupt file. */
async function _readPreferencesFile() {
  try {
    const raw = await fs.promises.readFile(_prefsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return _isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persists the candidate's chosen locale (survives app restarts).
 * Read-modify-write rather than a blind overwrite, so any other keys a future
 * feature stores in preferences.json aren't clobbered by a locale switch.
 */
async function setPreferred(locale) {
  const safe = SUPPORTED_CODES.has(locale) ? locale : DEFAULT_LOCALE;
  _preferred = safe;
  try {
    const existing = await _readPreferencesFile();
    const merged = { ...existing, locale: safe };
    await fs.promises.writeFile(_prefsFilePath(), JSON.stringify(merged), "utf8");
  } catch (err) {
    logger.warn("[locale] preference persist failed:", err.message);
  }
  return safe;
}

/** Returns { locale, bundle } in one call — the boot-time payload the renderer needs. */
function getBootstrap() {
  const locale = getPreferred();
  const bundle = getTranslations(locale);
  return { locale, bundle };
}

/**
 * Reads and caches a translation bundle from disk.
 * Falls back to English if the requested locale file is missing/invalid.
 * @param {string} locale
 * @returns {object}
 */
function getTranslations(locale) {
  const code = SUPPORTED_CODES.has(locale) ? locale : DEFAULT_LOCALE;
  if (_bundleCache.has(code)) {
    return _bundleCache.get(code);
  }

  if (code === DEFAULT_LOCALE) {
    let english;
    try {
      english = _readBundleFile(DEFAULT_LOCALE);
    } catch (err) {
      logger.warn(`[locale] failed to load bundle "${DEFAULT_LOCALE}":`, err.message);
      english = {};
    }
    _bundleCache.set(DEFAULT_LOCALE, english);
    return english;
  }

  try {
    const parsed = _readBundleFile(code);
    // English underneath so any key missing from this locale falls back to it,
    // with the locale's own values always winning where present.
    const english = getTranslations(DEFAULT_LOCALE);
    const merged = _deepMerge(english, parsed);
    // This fallback silences the renderer's own "missing key" warning, so the
    // gap is reported here instead — once per locale, at merge time. Empty in
    // a healthy build: test/locales.test.js fails CI on any key drift.
    const gaps = _missingKeys(english, parsed);
    if (gaps.length > 0) {
      logger.warn(
        `[locale] "${code}" is missing ${gaps.length} key(s), using English:`,
        gaps.join(", ")
      );
    }
    _bundleCache.set(code, merged);
    return merged;
  } catch (err) {
    logger.warn(
      `[locale] failed to load bundle "${code}", falling back to ${DEFAULT_LOCALE}:`,
      err.message
    );
    const english = getTranslations(DEFAULT_LOCALE);
    _bundleCache.set(code, english);
    return english;
  }
}

function _isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Recursively merges `overrides` onto `base`, `overrides` winning on any key present in both. */
function _deepMerge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (_isPlainObject(value) && _isPlainObject(out[key])) {
      out[key] = _deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Dot-path keys present in `base` but absent from `candidate`. Ignores "_"-prefixed metadata. */
function _missingKeys(base, candidate, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("_")) {
      continue;
    }
    const dotted = prefix ? `${prefix}.${key}` : key;
    const other = _isPlainObject(candidate) ? candidate[key] : undefined;
    if (_isPlainObject(value)) {
      out.push(..._missingKeys(value, other, dotted));
    } else if (other === undefined) {
      out.push(dotted);
    }
  }
  return out;
}

/** Reads and parses a locale bundle from disk, without caching or fallback. */
function _readBundleFile(code) {
  const fp = path.join(_localesDir(), `${code}.json`);
  const raw = fs.readFileSync(fp, "utf8");
  return JSON.parse(raw);
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
  getBootstrap,
};
