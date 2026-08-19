/**
 * Canonical email/password validation rules for the login form.
 *
 * Used directly here in main (ipcHandlers.js, as a backstop — Electron's
 * threat model assumes the renderer can be compromised, so main never trusts
 * it alone) and unit-tested in test/authValidators.test.js. The renderer is
 * sandboxed and can't require() this file, so src/renderer/login.js mirrors
 * these values by hand (same pattern as APP_DISPLAY_NAMES mirroring
 * shared/appList.js in preflight.js) — test/loginValidators.test.js asserts
 * the mirror hasn't drifted.
 *
 * Password complexity is informational only — see login.js: the backend, not
 * this file, is the actual authority on whether a password is valid for a
 * given account, so nothing here ever hard-blocks a login attempt from
 * reaching the server on complexity grounds alone.
 */

"use strict";

const EMAIL_MAX_LEN = 254;
const PASSWORD_MAX_LEN = 256;
const PASSWORD_MIN_LEN = 8;

// Deliberately not full RFC 5322 — that's a known, intentional simplification.
// This only exists to catch obvious typos before a wasted round trip; the
// backend remains the real authority on email validity.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Each rule is independently checkable so the UI can report every unmet rule
// at once, not just the first. ASCII-scoped by design: a unicode-only
// password should sensibly fail "uppercase"/"lowercase" rather than silently
// misbehaving — asserted explicitly in test/authValidators.test.js.
const PASSWORD_RULES = [
  { id: "minLength", test: (v) => v.length >= PASSWORD_MIN_LEN },
  { id: "uppercase", test: (v) => /[A-Z]/.test(v) },
  { id: "lowercase", test: (v) => /[a-z]/.test(v) },
  { id: "digit", test: (v) => /\d/.test(v) },
  // An explicit ASCII punctuation set, not "anything that isn't A-Za-z0-9" —
  // the latter would count a non-Latin letter (e.g. Cyrillic/Devanagari) as
  // a "symbol", which is wrong on its own terms even under the ASCII-only
  // design this file documents.
  { id: "symbol", test: (v) => /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/.test(v) },
];

/**
 * @param {string} value
 * @returns {{ valid: boolean, code: null | "required" | "tooLong" | "invalid" }}
 */
function validateEmail(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    return { valid: false, code: "required" };
  }
  if (v.length > EMAIL_MAX_LEN) {
    return { valid: false, code: "tooLong" };
  }
  if (!EMAIL_REGEX.test(v)) {
    return { valid: false, code: "invalid" };
  }
  return { valid: true, code: null };
}

/**
 * @param {string} value
 * @returns {{ valid: boolean, code: null | "required" | "tooLong", failedRules: string[] }}
 */
function validatePassword(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) {
    return { valid: false, code: "required", failedRules: [] };
  }
  if (v.length > PASSWORD_MAX_LEN) {
    return { valid: false, code: "tooLong", failedRules: [] };
  }
  // valid is deliberately NOT failedRules.length === 0 — see the file header.
  // Complexity misses are reported so the UI can hint at them, but they never
  // fail this function: the backend, not this file, decides whether a given
  // password is valid for a given account.
  const failedRules = PASSWORD_RULES.filter((r) => !r.test(v)).map((r) => r.id);
  return { valid: true, code: null, failedRules };
}

module.exports = {
  EMAIL_MAX_LEN,
  PASSWORD_MAX_LEN,
  PASSWORD_MIN_LEN,
  EMAIL_REGEX,
  PASSWORD_RULES,
  validateEmail,
  validatePassword,
};
