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

/**
 * Extracts every interpolation token a string requires a param for: plain
 * `{token}` placeholders and the binding variable of each ICU-lite plural
 * block (`{seconds, plural, one {# second} other {# seconds}}` requires
 * `seconds`). A plain `/\{(\w+)\}/g` scan finds none of a plural block's
 * tokens — the comma after the variable name defeats the `\w+\}` match — so
 * a key whose only token lives inside a plural block was invisible to parity
 * checking entirely, and a locale could drop it silently. Plural blocks are
 * located first and their span removed before the plain-token scan so CLDR
 * category labels (one/few/many/other) and the `#` count placeholder inside
 * branch bodies are never mistaken for tokens.
 */
function extractTokens(str) {
  const tokens = new Set();
  const s = String(str);
  const OPEN = /\{(\w+),\s*plural,\s*/g;
  let match;
  let lastEnd = 0;
  const plainTokenSource = [];
  while ((match = OPEN.exec(s))) {
    tokens.add(match[1]);
    plainTokenSource.push(s.slice(lastEnd, match.index));
    let depth = 1;
    let i = OPEN.lastIndex;
    while (i < s.length && depth > 0) {
      if (s[i] === "{") {depth++;}
      else if (s[i] === "}") {depth--;}
      i++;
    }
    lastEnd = i;
    OPEN.lastIndex = i;
  }
  plainTokenSource.push(s.slice(lastEnd));
  for (const chunk of plainTokenSource) {
    for (const m of chunk.matchAll(/\{(\w+)\}/g)) {
      tokens.add(m[1]);
    }
  }
  return [...tokens].sort();
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

test("every locale (including en) has provenance metadata: _reviewedBy and _sourceHash", () => {
  for (const code of localeFiles()) {
    const bundle = loadBundle(code);
    const reviewedBy = bundle?._meta?._reviewedBy;
    assert.ok(
      reviewedBy === null || typeof reviewedBy === "string",
      `${code}.json _meta._reviewedBy must be null or a string, got ${JSON.stringify(reviewedBy)}`
    );
    assert.ok(
      typeof bundle?._meta?._sourceHash === "string" && bundle._meta._sourceHash.length > 0,
      `${code}.json is missing a non-empty _meta._sourceHash`
    );
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
      const enTokens = extractTokens(enValue);
      if (enTokens.length === 0) {continue;}
      const localizedValue = flat[key];
      const localizedTokens = extractTokens(localizedValue);
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
