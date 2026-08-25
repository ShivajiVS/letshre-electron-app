"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT, "scripts/generate-pseudo-locale.js");
const EN_PATH = path.join(ROOT, "assets/locales/en.json");
// Written to a temp dir, not assets/locales-dev/ — that path is gitignored
// dev-only output (see the script's own header), and a test run must never
// leave the working tree dirty.
const OUT_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qps-ploc-")), "qps-ploc.json");

const { splitPreservingBraces } = require("../scripts/generate-pseudo-locale");

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

test("script runs without error and produces valid JSON", () => {
  execFileSync(process.execPath, [SCRIPT_PATH, OUT_PATH], { cwd: ROOT });
  assert.ok(fs.existsSync(OUT_PATH), "expected assets/locales-dev/qps-ploc.json to be written");
  const raw = fs.readFileSync(OUT_PATH, "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("covers every key present in en.json (no keys dropped)", () => {
  const enFlat = flatten(JSON.parse(fs.readFileSync(EN_PATH, "utf8")));
  const pseudoFlat = flatten(JSON.parse(fs.readFileSync(OUT_PATH, "utf8")));
  const missing = Object.keys(enFlat).filter((k) => !(k in pseudoFlat));
  assert.deepStrictEqual(missing, [], `keys dropped by pseudo-localization: ${missing.join(", ")}`);
});

test("preserves {token}/plural-block syntax exactly for every string", () => {
  const enFlat = flatten(JSON.parse(fs.readFileSync(EN_PATH, "utf8")));
  const pseudoFlat = flatten(JSON.parse(fs.readFileSync(OUT_PATH, "utf8")));
  const mismatches = [];
  for (const [key, enValue] of Object.entries(enFlat)) {
    if (typeof enValue !== "string") {
      continue;
    }
    const enTokens = splitPreservingBraces(enValue)
      .filter((s) => s.type === "token")
      .map((s) => s.value);
    const pseudoValue = pseudoFlat[key];
    const pseudoTokens = splitPreservingBraces(pseudoValue)
      .filter((s) => s.type === "token")
      .map((s) => s.value);
    if (JSON.stringify(enTokens) !== JSON.stringify(pseudoTokens)) {
      mismatches.push(key);
    }
  }
  assert.deepStrictEqual(
    mismatches,
    [],
    `{token}/plural-block syntax changed by pseudo-localization: ${mismatches.join(", ")}`
  );
});

test("pads every non-empty string noticeably longer than the source", () => {
  const enFlat = flatten(JSON.parse(fs.readFileSync(EN_PATH, "utf8")));
  const pseudoFlat = flatten(JSON.parse(fs.readFileSync(OUT_PATH, "utf8")));
  const notPadded = Object.entries(enFlat)
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([k]) => k)
    .filter((k) => pseudoFlat[k].length <= enFlat[k].length);
  assert.deepStrictEqual(notPadded, [], `not padded longer than source: ${notPadded.join(", ")}`);
});
