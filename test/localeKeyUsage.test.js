"use strict";

/**
 * Cross-checks i18n keys against source code by literal substring/regex
 * scanning rather than parsing each calling convention (tuple arrays,
 * key-lookup maps, data-i18n attributes, direct tr()/window.t() calls all
 * leave the dot-path key as a literal quoted string somewhere in the file,
 * so a substring scan catches all of them without modeling call syntax).
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOCALES_DIR = path.join(ROOT, "assets/locales");
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

function readFilesConcat(patterns) {
  const files = [];
  for (const dir of patterns) {
    const full = path.join(ROOT, dir.dir);
    if (!fs.existsSync(full)) {continue;}
    for (const f of fs.readdirSync(full)) {
      if (dir.ext.some((e) => f.endsWith(e))) {
        files.push(path.join(full, f));
      }
    }
  }
  return files.map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") }));
}

const SOURCE_FILES = readFilesConcat([
  { dir: "assets", ext: [".html"] },
  { dir: "src/renderer", ext: [".js"] },
  { dir: "src/main", ext: [".js"] },
]);
const ALL_SOURCE_TEXT = SOURCE_FILES.map((f) => f.text).join("\n");

const sourceFlat = flatten(loadBundle(SOURCE_LOCALE));
const sourceKeys = Object.keys(sourceFlat).sort();

/**
 * Keys intentionally not referenced by a literal key string in source.
 * Start empty; only add an entry here with a one-line justification.
 */
const DEAD_KEY_ALLOWLIST = [];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-based rather than quote-wrapped: data-i18n-attr packs keys as
 * `"attr:key.path|attr2:key2.path"`, so the key is bounded by `:`/`|`/`"`,
 * not independently quoted. A pure `"key"`/'key'` check would false-positive
 * on every data-i18n-attr reference (e.g. role.inputPlaceholder).
 */
function isReferenced(key) {
  const re = new RegExp(`(^|[^\\w.])${escapeRegExp(key)}($|[^\\w.])`);
  return re.test(ALL_SOURCE_TEXT);
}

test("every en.json key is referenced somewhere in assets/*.html, src/renderer/*.js, or src/main/*.js", () => {
  const unreferenced = sourceKeys.filter((key) => {
    if (DEAD_KEY_ALLOWLIST.includes(key)) {return false;}
    return !isReferenced(key);
  });
  assert.deepStrictEqual(
    unreferenced,
    [],
    `en.json keys with no literal reference found in source: ${unreferenced.join(", ")}`
  );
});

/**
 * Non-key dot-path-shaped literals discovered in source that are not i18n
 * keys (version strings, filenames, etc). Extend as new false positives
 * are found by actually running the test.
 */
const NON_KEY_LITERAL_ALLOWLIST_PATTERNS = [
  /^\d+(\.\d+)+$/, // semver-ish version numbers
  /\.(js|json|css|html|png|jpg|jpeg|svg|ico|webm|mp4|node|exe)$/i, // filenames
  /^[\w-]+\.[\w-]+$/, // single-dot tokens with no further structure get extra scrutiny below
];

const DOT_PATH_LITERAL_RE = /(["'])([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)\1/g;

function extractDotPathLiterals(text) {
  const found = new Set();
  let m;
  while ((m = DOT_PATH_LITERAL_RE.exec(text))) {
    found.add(m[2]);
  }
  return found;
}

const allLiterals = new Set();
for (const { text } of SOURCE_FILES) {
  for (const lit of extractDotPathLiterals(text)) {
    allLiterals.add(lit);
  }
}

/**
 * Literals that look like dot-paths but are verified NOT to be i18n keys
 * (e.g. IPC channel names, CSS custom properties referenced as strings,
 * data-i18n-attr's "attr:key" left half, event names). Populate only after
 * confirming via grep that the literal is not meant to resolve against a
 * locale bundle.
 */
const NON_I18N_LITERAL_ALLOWLIST = [];

test("every dot-path-shaped string literal in assets/*.html and src/renderer/*.js that looks like an i18n key exists in en.json", () => {
  const candidates = [...allLiterals].filter((lit) => {
    if (sourceKeys.includes(lit)) {return false;}
    if (NON_I18N_LITERAL_ALLOWLIST.includes(lit)) {return false;}
    if (NON_KEY_LITERAL_ALLOWLIST_PATTERNS.some((re) => re.test(lit))) {return false;}
    return true;
  });
  assert.deepStrictEqual(
    candidates,
    [],
    `dot-path-shaped literals found in source that do not match any en.json key: ${candidates.join(", ")}`
  );
});
