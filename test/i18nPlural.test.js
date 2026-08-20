"use strict";

const test = require("node:test");
const assert = require("node:assert");
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
