"use strict";

/**
 * Flags locale values that are byte-identical to the English source. Most
 * are genuine cognates/borrowed words; a few are untranslated leaks. Every
 * identical value must either fall under the noise filter below or be in
 * the per-locale cognate allowlist.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "../assets/locales");
const SOURCE_LOCALE = "en";

function loadBundle(code) {
  const raw = fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), "utf8");
  return JSON.parse(raw);
}

function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_")) {
      continue;
    }
    const path_ = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path_));
    } else {
      out[path_] = value;
    }
  }
  return out;
}

function localeFiles() {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

const sourceFlat = flatten(loadBundle(SOURCE_LOCALE));

/**
 * A value carries no translatable content if, once {tokens} are stripped,
 * fewer than 3 letters remain (covers pure punctuation like "→", lone
 * ellipses, and single-token strings like "{seconds}"). 3 is the shortest
 * real English word ("Yes"/"Non" as a fragment would be 3+ anyway) that
 * could plausibly still need translation.
 */
function hasTranslatableContent(value) {
  const stripped = String(value).replace(/\{\w+\}/g, "");
  const letters = stripped.replace(/[^\p{L}]/gu, "");
  return letters.length >= 3;
}

/**
 * Per-locale keys verified as genuine cognates/borrowed words identical in
 * both English and the target language — not missed translations.
 */
// `hiw.pageTitle` is a brand-new key (window <title>, A8) added to every
// locale file only to satisfy key-parity — per the locale-gate plan, new keys
// get an English placeholder rather than a real translation, since these 18
// bundles are all pre-certification anyway (_meta._reviewedBy is null) and
// will get a real pass from a certified translator together.
const NEW_KEY_PLACEHOLDER_ALLOWLIST = ["hiw.pageTitle"];

const COGNATE_ALLOWLIST = {
  de: [
    "identity.pause", // German word for pause/break is spelled identically: "Pause"
  ],
  fr: [
    "perm.micName", // French word for microphone is spelled identically: "microphone"
    "identity.stepPhoto", // French word for photo is spelled identically: "photo"
    "identity.pause", // French word for pause is spelled identically: "pause"
  ],
  id: [
    "login.emailLabel", // Indonesian UI conventionally borrows "Email" unchanged, no native equivalent in common use
  ],
  it: [
    "login.passwordLabel", // Italian UI conventionally borrows "Password" unchanged, no native equivalent in common use
  ],
  nl: [
    "perm.cameraName", // Dutch word for camera is spelled identically: "camera"
  ],
};

for (const code of localeFiles()) {
  if (code === SOURCE_LOCALE) {continue;}

  test(`${code}.json has no untranslated (English-identical) values outside the cognate allowlist`, () => {
    const flat = flatten(loadBundle(code));
    const allowlist = [...(COGNATE_ALLOWLIST[code] || []), ...NEW_KEY_PLACEHOLDER_ALLOWLIST];
    const offenders = [];
    for (const [key, enValue] of Object.entries(sourceFlat)) {
      if (typeof enValue !== "string") {continue;}
      if (!hasTranslatableContent(enValue)) {continue;}
      if (flat[key] !== enValue) {continue;}
      if (allowlist.includes(key)) {continue;}
      offenders.push(key);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `${code}.json has untranslated English-identical values not in the cognate allowlist: ${offenders.join(", ")}`
    );
  });
}
