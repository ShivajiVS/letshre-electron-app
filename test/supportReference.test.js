"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const LOGGER = require.resolve("../src/main/logger");
const noop = () => {};
require.cache[LOGGER] = {
  id: LOGGER,
  filename: LOGGER,
  loaded: true,
  exports: { info: noop, warn: noop, error: noop, debug: noop },
};

const ref = require("../src/main/supportReference");

test("a reference code is LH- and two groups of four base32 letters", () => {
  for (const seed of ["", "a", "session-1", "8f0e1c9a-7d3b-4d2a-9b1e-2f6c3a4b5d6e", 42]) {
    assert.match(ref.referenceCodeFor(seed), /^LH-[A-Z2-7]{4}-[A-Z2-7]{4}$/, String(seed));
    assert.match(ref.referenceCodeFor(seed), ref.CODE_PATTERN);
  }
});

test("the code is the first 40 bits of the seed's SHA-256 in RFC 4648 base32", () => {
  // sha256("abc") starts ba 78 16 bf 8f → base32 XJ4BNP4P
  assert.strictEqual(ref.referenceCodeFor("abc"), "LH-XJ4B-NP4P");
});

test("the same seed always gives the same code, and different seeds differ", () => {
  assert.strictEqual(ref.referenceCodeFor("session-1"), ref.referenceCodeFor("session-1"));
  assert.notStrictEqual(ref.referenceCodeFor("session-1"), ref.referenceCodeFor("session-2"));
});

test("before a session the code is the attempt's; after, the session's", () => {
  ref.startRun();
  const run = ref.currentCode();
  assert.match(run, ref.CODE_PATTERN);
  assert.strictEqual(ref.currentCode(), run, "stable within an attempt");

  ref.rememberSession("session-9");
  assert.strictEqual(ref.currentCode(), ref.referenceCodeFor("session-9"));

  ref.rememberSession(null);
  ref.rememberSession("");
  assert.strictEqual(ref.currentCode(), ref.referenceCodeFor("session-9"), "ignores empty ids");

  ref.startRun();
  assert.notStrictEqual(ref.currentCode(), ref.referenceCodeFor("session-9"));
  assert.notStrictEqual(ref.currentCode(), run);
});
