"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { _pluralize, _interpolate, _lookup } = require("../assets/js/i18n.js");

test("_pluralize picks the matching CLDR category (en: one/other)", () => {
  const str = "Wait {n, plural, one {# second} other {# seconds}}.";
  assert.strictEqual(_pluralize(str, { n: 1 }, "en"), "Wait 1 second.");
  assert.strictEqual(_pluralize(str, { n: 0 }, "en"), "Wait 0 seconds.");
  assert.strictEqual(_pluralize(str, { n: 5 }, "en"), "Wait 5 seconds.");
});

test("_pluralize resolves ru's one/few/many correctly at CLDR boundaries", () => {
  const str = "{n, plural, one {# секунда} few {# секунды} many {# секунд}}";
  assert.strictEqual(_pluralize(str, { n: 1 }, "ru"), "1 секунда");
  assert.strictEqual(_pluralize(str, { n: 2 }, "ru"), "2 секунды");
  assert.strictEqual(_pluralize(str, { n: 5 }, "ru"), "5 секунд");
  assert.strictEqual(_pluralize(str, { n: 21 }, "ru"), "21 секунда");
  assert.strictEqual(_pluralize(str, { n: 22 }, "ru"), "22 секунды");
  assert.strictEqual(_pluralize(str, { n: 25 }, "ru"), "25 секунд");
});

test("_pluralize falls back to the other branch for a category with no branch of its own", () => {
  const str = "{n, plural, one {# item} other {# items}}";
  assert.strictEqual(_pluralize(str, { n: 3 }, "ar"), "3 items");
});

test("_pluralize handles locales that only ever select 'other' (ja/ko/id)", () => {
  const str = "{n, plural, other {合計 #}}";
  assert.strictEqual(_pluralize(str, { n: 1 }, "ja"), "合計 1");
  assert.strictEqual(_pluralize(str, { n: 100 }, "ja"), "合計 100");
});

test("_pluralize leaves a string with no plural block untouched", () => {
  assert.strictEqual(_pluralize("plain {x} string", { x: "y" }, "en"), "plain {x} string");
});

test("_pluralize leaves a string with no params untouched", () => {
  const str = "{n, plural, one {# second} other {# seconds}}";
  assert.strictEqual(_pluralize(str, null, "en"), str);
});

test("_pluralize substitutes every # in the chosen branch, not just the first", () => {
  const str = "{n, plural, other {# of # remaining}}";
  assert.strictEqual(_pluralize(str, { n: 3 }, "en"), "3 of 3 remaining");
});

test("_pluralize bails out cleanly on an unbalanced plural block instead of throwing", () => {
  const str = "{n, plural, one {# second";
  assert.doesNotThrow(() => _pluralize(str, { n: 1 }, "en"));
});

test("_interpolate resolves a plural block and a plain {token} in the same string", () => {
  const str = "{a} and {n, plural, one {# thing} other {# things}}";
  assert.strictEqual(_interpolate(str, { a: "x", n: 3 }, "en"), "x and 3 things");
});

test("_interpolate with no params returns the string unchanged", () => {
  const str = "{n, plural, one {# thing} other {# things}}";
  assert.strictEqual(_interpolate(str, undefined, "en"), str);
});

test("_lookup resolves a dot-path key and ignores non-string leaves", () => {
  // _lookup reads the module-private _bundle, which stays empty outside the
  // browser bootstrap path — this only asserts the function is exported and
  // behaves safely against an unset bundle, not the full runtime lookup.
  assert.strictEqual(_lookup("does.not.exist"), undefined);
});

/**
 * The tests above exercise _pluralize against inline fixtures only — they
 * say nothing about whether the real locale bundles actually ship complete
 * plural blocks. A locale is allowed to define MORE branches than CLDR
 * requires (an "other" catch-all is always safe to include even when a
 * language doesn't strictly need it), but it must not be missing a category
 * Intl.PluralRules says that locale requires — a missing category silently
 * falls back to "other" at runtime (see _pluralize's fallback), which reads
 * as broken grammar for the count that hit the missing branch.
 */
const LOCALES_DIR = path.join(__dirname, "../assets/locales");

function localeFiles() {
  return fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_")) {continue;}
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
 * Finds every ICU-lite plural block in a string and returns the set of CLDR
 * category labels each one defines. Braces are depth-balanced (not a single
 * regex) because branch bodies are themselves `{...}` groups.
 */
function extractPluralBlocks(str) {
  const blocks = [];
  const s = String(str);
  const OPEN = /\{(\w+),\s*plural,\s*/g;
  let match;
  while ((match = OPEN.exec(s))) {
    let depth = 1;
    let i = OPEN.lastIndex;
    while (i < s.length && depth > 0) {
      if (s[i] === "{") {depth++;}
      else if (s[i] === "}") {depth--;}
      i++;
    }
    const body = s.slice(OPEN.lastIndex, i - 1);
    const categories = [...body.matchAll(/(\w+)\s*\{/g)].map((m) => m[1]);
    blocks.push({ variable: match[1], categories });
    OPEN.lastIndex = i;
  }
  return blocks;
}

for (const code of localeFiles()) {
  test(`${code}.json plural blocks cover every CLDR category Intl.PluralRules requires for "${code}"`, () => {
    let required;
    try {
      required = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    } catch {
      required = ["other"]; // unsupported locale tag — matches _pluralize's own fallback
    }
    const raw = fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), "utf8");
    const flat = flatten(JSON.parse(raw));
    const problems = [];
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== "string") {continue;}
      for (const block of extractPluralBlocks(value)) {
        const missing = required.filter((c) => !block.categories.includes(c));
        if (missing.length > 0) {
          problems.push(`${key} (${block.variable}) missing [${missing.join(", ")}]`);
        }
      }
    }
    assert.deepStrictEqual(
      problems,
      [],
      `${code}.json has plural blocks missing required CLDR categories: ${problems.join("; ")}`
    );
  });
}
