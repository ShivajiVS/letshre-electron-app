"use strict";

/**
 * Stamps provenance metadata into every assets/locales/*.json bundle:
 *   - `_meta._reviewedBy`: null until a locale is human-certified (including
 *     `en` — it's the source-of-truth bundle, not a "reviewed translation").
 *   - `_meta._sourceHash`: a hash of en.json's flattened string values at the
 *     time this locale was last synced, so a future tooling pass can detect
 *     drift (en.json changing after a locale was certified against it).
 *
 * The hash is computed over flattened dot-path -> value pairs (mirroring
 * test/locales.test.js's `flatten()`), not raw file bytes, so key reordering
 * or whitespace in en.json doesn't produce a false-positive drift signal.
 *
 * Usage: node scripts/sync-locale-provenance.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

/** Stable (sorted-key) hash of en.json's flattened string values, truncated SHA-256. */
function computeSourceHash() {
  const flat = flatten(loadBundle(SOURCE_LOCALE));
  const sortedKeys = Object.keys(flat).sort();
  const canonical = sortedKeys.map((k) => `${k}=${flat[k]}`).join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

function localeFiles() {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function main() {
  const sourceHash = computeSourceHash();
  for (const code of localeFiles()) {
    const fp = path.join(LOCALES_DIR, `${code}.json`);
    const bundle = loadBundle(code);
    bundle._meta = {
      ...bundle._meta,
      _reviewedBy: null,
      _sourceHash: sourceHash,
    };
    fs.writeFileSync(fp, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`stamped ${code}.json`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nsourceHash: ${sourceHash}`);
}

main();
