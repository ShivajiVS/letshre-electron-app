"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { createStartWatchdog } = require("../src/main/startWatchdog");

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    pending,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    async fireNext() {
      const [id, { fn }] = pending.entries().next().value;
      pending.delete(id);
      await fn();
    },
  };
}

function setup(answers) {
  const timers = fakeTimers();
  let asked = 0;
  const watchdog = createStartWatchdog({
    stallAfterMs: 90,
    askAgainMs: 60,
    timers,
    onStall: async () => answers[asked++],
  });
  return { timers, watchdog, asked: () => asked };
}

test("asks once the interview hasn't started in time, and again while they keep waiting", async () => {
  const { timers, watchdog, asked } = setup([false, true]);
  watchdog.arm();
  assert.strictEqual([...timers.pending.values()][0].ms, 90);

  await timers.fireNext();
  assert.strictEqual(asked(), 1);
  assert.strictEqual([...timers.pending.values()][0].ms, 60);

  await timers.fireNext();
  assert.strictEqual(asked(), 2);
  assert.strictEqual(timers.pending.size, 0, "stops asking once they leave");
});

test("never asks once the interview is live or over", () => {
  const { timers, watchdog } = setup([]);
  watchdog.arm();
  watchdog.markLive();
  assert.strictEqual(timers.pending.size, 0);
  assert.strictEqual(watchdog.isLive(), true);

  watchdog.arm();
  assert.strictEqual(watchdog.isLive(), false, "a new interview starts not live");
  watchdog.disarm();
  assert.strictEqual(timers.pending.size, 0);
});

test("a start that goes live while the dialog is open isn't asked about again", async () => {
  const timers = fakeTimers();
  const watchdog = createStartWatchdog({
    timers,
    onStall: async () => {
      watchdog.markLive();
      return false;
    },
  });
  watchdog.arm();
  await timers.fireNext();
  assert.strictEqual(timers.pending.size, 0);
});

test("a failing dialog counts as keep waiting", async () => {
  const timers = fakeTimers();
  const watchdog = createStartWatchdog({
    timers,
    onStall: async () => {
      throw new Error("no window");
    },
  });
  watchdog.arm();
  await timers.fireNext();
  assert.strictEqual(timers.pending.size, 1);
});
