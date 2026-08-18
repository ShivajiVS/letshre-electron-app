"use strict";

/**
 * Accuracy guardrails for the i18n locale bundles (assets/locales/*.json):
 * exact key parity with the English source, no empty values, and
 * interpolation-token parity. This is only the mechanical half — semantic
 * accuracy (especially attestation.statement, read aloud by the candidate for
 * voice verification) requires human certified-translator sign-off, which is
 * a process step no test can verify.
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

/** Flattens a nested object into dot-path -> value pairs, skipping keys starting with "_". */
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

const sourceBundle = loadBundle(SOURCE_LOCALE);
const sourceFlat = flatten(sourceBundle);
const sourceKeys = Object.keys(sourceFlat).sort();

test("locale directory contains the English source bundle", () => {
  assert.ok(fs.existsSync(path.join(LOCALES_DIR, `${SOURCE_LOCALE}.json`)));
});

test("every locale is valid JSON and parses to an object", () => {
  for (const code of localeFiles()) {
    const bundle = loadBundle(code);
    assert.strictEqual(typeof bundle, "object");
  }
});

for (const code of localeFiles()) {
  if (code === SOURCE_LOCALE) {continue;}

  test(`${code}.json has exactly the same keys as en.json`, () => {
    const flat = flatten(loadBundle(code));
    const keys = Object.keys(flat).sort();
    const missing = sourceKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !sourceKeys.includes(k));
    assert.deepStrictEqual(missing, [], `${code}.json is missing keys: ${missing.join(", ")}`);
    assert.deepStrictEqual(
      extra,
      [],
      `${code}.json has extra keys not in en.json: ${extra.join(", ")}`
    );
  });

  test(`${code}.json has no empty or whitespace-only values`, () => {
    const flat = flatten(loadBundle(code));
    for (const [key, value] of Object.entries(flat)) {
      assert.ok(
        typeof value === "string" && value.trim().length > 0,
        `${code}.json key "${key}" is empty`
      );
    }
  });

  test(`${code}.json preserves every {token} interpolation placeholder from en.json`, () => {
    const flat = flatten(loadBundle(code));
    for (const [key, enValue] of Object.entries(sourceFlat)) {
      const enTokens = [...String(enValue).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      if (enTokens.length === 0) {continue;}
      const localizedValue = flat[key];
      const localizedTokens = [...String(localizedValue).matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort();
      assert.deepStrictEqual(
        localizedTokens,
        enTokens,
        `${code}.json key "${key}" interpolation tokens mismatch: expected [${enTokens}], got [${localizedTokens}]`
      );
    }
  });

  test(`${code}.json has a non-empty, certified-flagged attestation.statement`, () => {
    const bundle = loadBundle(code);
    assert.ok(
      typeof bundle?.attestation?.statement === "string" &&
        bundle.attestation.statement.trim().length > 0,
      `${code}.json is missing attestation.statement — this is the read-aloud voice-verification line`
    );
    assert.strictEqual(
      bundle.attestation._certifiedTranslationRequired,
      true,
      `${code}.json attestation namespace must keep _certifiedTranslationRequired: true`
    );
  });
}
