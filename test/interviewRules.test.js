"use strict";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const rules = require("../src/main/interviewRules");

const GOOD = {
  version: 1,
  strikes: 3,
  faceInARow: 2,
  faceTotal: 3,
  disconnects: 3,
  heldSeconds: 30,
};

let requested;
function serve(respond) {
  rules._config.get = async (url, opts) => {
    requested = { url, opts };
    return respond();
  };
}

beforeEach(() => {
  requested = null;
  rules.reset();
});

test("reads interview-rules.json from the site's root, whatever page the interview opens on", async () => {
  serve(() => ({ data: GOOD }));
  const res = await rules.fetchRules("https://interview.letshyre.com/session?lang=hi");
  assert.deepStrictEqual(res, { ok: true, rules: GOOD });
  assert.strictEqual(requested.url, "https://interview.letshyre.com/interview-rules.json");
  assert.ok(requested.opts.timeout > 0);
});

test("keeps only the known fields", async () => {
  serve(() => ({ data: { ...GOOD, note: "<b>x</b>" } }));
  assert.deepStrictEqual((await rules.fetchRules("https://x.test/")).rules, GOOD);
});

test("anything malformed is treated as no rules", async () => {
  const bad = [
    null,
    "<html>",
    { ...GOOD, strikes: 0 },
    { ...GOOD, faceTotal: "3" },
    { ...GOOD, version: 1.5 },
  ];
  for (const data of bad) {
    serve(() => ({ data }));
    assert.deepStrictEqual(await rules.fetchRules("https://x.test/"), { ok: false });
  }
});

test("a failed request is no rules, never a throw", async () => {
  serve(() => {
    throw new Error("timeout of 5000ms exceeded");
  });
  assert.deepStrictEqual(await rules.fetchRules("https://x.test/"), { ok: false });
});

test("the acknowledgement uses the numbers main fetched, and only when accepted", async () => {
  const now = new Date("2026-09-30T10:00:00.000Z");
  assert.strictEqual(rules.acknowledgementFor(true, now), null);

  serve(() => ({ data: GOOD }));
  await rules.fetchRules("https://x.test/");
  assert.strictEqual(rules.acknowledgementFor(false, now), null);
  assert.deepStrictEqual(rules.acknowledgementFor(true, now), { ...GOOD, at: now.toISOString() });

  serve(() => ({ data: null }));
  await rules.fetchRules("https://x.test/");
  assert.strictEqual(rules.acknowledgementFor(true, now), null);
});
