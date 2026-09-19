"use strict";

const { test, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const checks = require("../src/detector/systemChecks");
const { HARD_BLOCK_GRACE_MS } = require("../src/shared/constants");

function fakeWin() {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, ...payload });
  return { webContents, sent, isDestroyed: () => false };
}

let win;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  checks.resetState();
  win = fakeWin();
  checks.start(win);
});

afterEach(() => {
  checks.stop();
  mock.timers.reset();
});

test("an unacknowledged hard block is sent again and the session stays live", () => {
  checks.sendViolation(win, "Window minimize attempt", "high");
  assert.strictEqual(win.sent.length, 1);

  mock.timers.tick(HARD_BLOCK_GRACE_MS);

  assert.strictEqual(win.sent.length, 2);
  assert.strictEqual(win.sent[1].event, "Window minimize attempt");
  assert.strictEqual(win.sent[1].redelivered, true);
  assert.strictEqual(checks.isSessionActive(), true, "detection must keep running");
});

test("an acknowledged hard block is not sent again", () => {
  checks.sendViolation(win, "Attempt to close interview window", "high");
  checks.acknowledgeViolation();

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);

  assert.strictEqual(win.sent.length, 1);
});

test("the interview page loading resends a hard block it may have missed", () => {
  checks.sendViolation(win, "External display detected", "high");
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 2);
  assert.strictEqual(win.sent[1].redelivered, true);
});

test("soft violations are never resent", () => {
  checks.sendViolation(win, "Fullscreen exit attempt", "medium");
  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 1);
});

test("nothing is resent once the interview has ended", () => {
  checks.sendViolation(win, "Blocked application running during interview: Zoom", "high");
  checks.stop();

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 1);
  assert.strictEqual(win.webContents.listenerCount("did-finish-load"), 0);
});
