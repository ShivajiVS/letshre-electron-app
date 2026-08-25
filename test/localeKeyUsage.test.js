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

/** Recursively collects file paths under `dir`, skipping node_modules/dotfiles. */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function readFilesConcat(patterns) {
  const files = new Set();
  for (const dir of patterns) {
    const full = path.join(ROOT, dir.dir);
    for (const f of walk(full)) {
      if (dir.ext.some((e) => f.endsWith(e))) {
        files.add(f);
      }
    }
  }
  return [...files].map((f) => ({ file: f, text: fs.readFileSync(f, "utf8") }));
}

const SOURCE_FILES = readFilesConcat([
  { dir: "assets", ext: [".html"] },
  { dir: "assets/js", ext: [".js"] },
  { dir: "src/renderer", ext: [".js"] },
  { dir: "src/main", ext: [".js"] },
  { dir: "src/detector", ext: [".js"] },
  { dir: "src/shared", ext: [".js"] },
]);
const PRELOAD_PATH = path.join(ROOT, "preload.js");
if (fs.existsSync(PRELOAD_PATH)) {
  SOURCE_FILES.push({ file: PRELOAD_PATH, text: fs.readFileSync(PRELOAD_PATH, "utf8") });
}
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
    if (DEAD_KEY_ALLOWLIST.includes(key)) {
      return false;
    }
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
const NON_I18N_LITERAL_ALLOWLIST = [
  "zoom.us.app", // macOS bundle name in src/shared/appList.js's blocklist, not an i18n key
];

test("every dot-path-shaped string literal in assets/*.html and src/renderer/*.js that looks like an i18n key exists in en.json", () => {
  const candidates = [...allLiterals].filter((lit) => {
    if (sourceKeys.includes(lit)) {
      return false;
    }
    if (NON_I18N_LITERAL_ALLOWLIST.includes(lit)) {
      return false;
    }
    if (NON_KEY_LITERAL_ALLOWLIST_PATTERNS.some((re) => re.test(lit))) {
      return false;
    }
    return true;
  });
  assert.deepStrictEqual(
    candidates,
    [],
    `dot-path-shaped literals found in source that do not match any en.json key: ${candidates.join(", ")}`
  );
});

/**
 * Renderer-facing files where a hardcoded DOM-text assignment bypasses
 * tr()/window.t() entirely and would ship unlocalized (and frozen across
 * locale switches, since the [data-i18n] sweep never touches it).
 */
const RENDERER_TEXT_FILES = SOURCE_FILES.filter(({ file }) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  return rel.startsWith("src/renderer/") || rel.startsWith("assets/js/") || rel === "preload.js";
});

/** Blanks out comments so example code in a JSDoc block isn't mistaken for real assignments. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

/** Log calls in this codebase are styled `logger.warn("[tag]", "message")` — not user-facing. */
const LOG_STYLE_RE = /^\s*\[[\w-]+\]/;

/**
 * Only single/double-quoted literals are checked — template literals mixing
 * markup with `${tr(...)}` calls are the norm here and would be all false
 * positives. The trailing lookahead requires the literal to be the WHOLE
 * right-hand side (terminated by `;`/newline/EOF), not merely the first token
 * of a larger expression — otherwise `"raw" in errorState ? errorState.raw :
 * tr(...)` reads as if "raw" were assigned directly.
 */
const DOM_TEXT_ASSIGN_RE =
  /\.(textContent|innerText|innerHTML)\s*=\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2\s*(?=[;\n]|$)/g;

function findHardcodedDomText(text) {
  const clean = stripComments(text);
  const hits = [];
  let m;
  DOM_TEXT_ASSIGN_RE.lastIndex = 0;
  while ((m = DOM_TEXT_ASSIGN_RE.exec(clean))) {
    const [, prop, , value] = m;
    if (!/[A-Za-z]{2,}/.test(value)) {
      continue;
    } // no real word: icons, "", punctuation
    if (LOG_STYLE_RE.test(value)) {
      continue;
    }
    hits.push({ prop, value });
  }
  return hits;
}

/**
 * Literal DOM-text assignments verified NOT user-facing (e.g. a debug-only
 * overlay). Populate only after confirming by inspection.
 */
const HARDCODED_TEXT_ALLOWLIST = [];

test("no renderer-facing JS assigns a hardcoded string literal to textContent/innerText/innerHTML instead of routing through tr()/window.t()", () => {
  const violations = [];
  for (const { file, text } of RENDERER_TEXT_FILES) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const hit of findHardcodedDomText(text)) {
      const entry = `${rel}: .${hit.prop} = "${hit.value}"`;
      if (HARDCODED_TEXT_ALLOWLIST.includes(entry)) {
        continue;
      }
      violations.push(entry);
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    `hardcoded user-facing string(s) assigned directly to the DOM instead of tr()/window.t(): ${violations.join(", ")}`
  );
});
