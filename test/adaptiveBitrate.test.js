"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { LADDER, createBitrateController } = require("../src/main/adaptiveBitrate");

const OPTS = { stepDownAt: 3, calmAt: 1, holdMs: 45_000, stepUpAfterMs: 180_000 };

test("starts at the top of the ladder", () => {
  assert.strictEqual(createBitrateController(OPTS).bitsPerSecond, LADDER[0]);
});

test("a normal backlog leaves the bitrate alone", () => {
  const c = createBitrateController(OPTS);
  for (let t = 0; t < 600_000; t += 15_000) {
    assert.strictEqual(c.observe(t % 30_000 === 0 ? 2 : 1, t), null);
  }
});

test("steps down one level when uploads fall behind", () => {
  const c = createBitrateController(OPTS);
  assert.strictEqual(c.observe(3, 0), LADDER[1]);
  assert.strictEqual(c.bitsPerSecond, LADDER[1]);
});

test("waits between steps so each one can take effect", () => {
  const c = createBitrateController(OPTS);
  c.observe(5, 0);
  assert.strictEqual(c.observe(6, 15_000), null);
  assert.strictEqual(c.observe(6, 45_000), LADDER[2]);
});

test("never drops below the floor", () => {
  const c = createBitrateController(OPTS);
  for (let t = 0; t < 1_000_000; t += 15_000) {
    c.observe(10, t);
  }
  assert.strictEqual(c.bitsPerSecond, LADDER[LADDER.length - 1]);
});

test("steps back up only after uploads keep pace for a sustained stretch", () => {
  const c = createBitrateController(OPTS);
  c.observe(4, 0);

  assert.strictEqual(c.observe(1, 60_000), null);
  assert.strictEqual(c.observe(1, 200_000), null, "calm for only 140 s");
  assert.strictEqual(c.observe(1, 240_000), LADDER[0]);
});

test("a spike during the calm stretch restarts it", () => {
  const c = createBitrateController(OPTS);
  c.observe(4, 0);
  c.observe(1, 60_000);
  c.observe(2, 150_000);

  assert.strictEqual(c.observe(1, 240_000), null);
  assert.strictEqual(c.observe(1, 420_000), LADDER[0]);
});
