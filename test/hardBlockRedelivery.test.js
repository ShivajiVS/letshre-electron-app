"use strict";

const { test, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { loadSystemChecks } = require("./_preflightHarness");
const { HARD_BLOCK_GRACE_MS } = require("../src/shared/constants");
const { CODE } = require("../src/shared/violationCodes");

function fakeWin() {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, ...payload });
  return { webContents, sent, isDestroyed: () => false };
}

let h;
let checks;
let win;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  h = loadSystemChecks();
  checks = h.checks;
  win = fakeWin();
  checks.start(win);
});

afterEach(() => {
  checks.stop();
  h.unload();
  mock.timers.reset();
});

test("an unacknowledged hard block is sent again once, same id, and the session stays live", () => {
  checks.sendViolation(win, "Window minimize attempt", "high", { code: CODE.WINDOW_MINIMIZE });
  assert.strictEqual(win.sent.length, 1);
  assert.strictEqual(win.sent[0].redelivered, undefined);

  mock.timers.tick(HARD_BLOCK_GRACE_MS);

  assert.strictEqual(win.sent.length, 2);
  assert.strictEqual(win.sent[1].id, win.sent[0].id);
  assert.strictEqual(win.sent[1].code, CODE.WINDOW_MINIMIZE);
  assert.strictEqual(win.sent[1].redelivered, true);

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  assert.strictEqual(win.sent.length, 2, "the grace re-send happens once");
  assert.strictEqual(checks.isSessionActive(), true, "detection must keep running");
});

test("acknowledging the hard block by id cancels its re-send", () => {
  checks.sendViolation(win, "Attempt to close interview window", "high");
  checks.acknowledgeViolation(win.sent[0].id);

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 1);
});

test("an ack without an id acknowledges everything, as older site builds send it", () => {
  checks.sendViolation(win, "Attempt to close interview window", "high");
  checks.sendViolation(win, "Fullscreen exit attempt", "medium");
  checks.acknowledgeViolation();

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 2);
});

test("acknowledging another violation leaves the hard block pending", () => {
  checks.sendViolation(win, "External display detected", "high");
  checks.sendViolation(win, "Fullscreen exit attempt", "medium");
  checks.acknowledgeViolation(win.sent[1].id);

  mock.timers.tick(HARD_BLOCK_GRACE_MS);

  assert.strictEqual(win.sent.length, 3);
  assert.strictEqual(win.sent[2].id, win.sent[0].id);
});

test("the next hard block gets its own grace re-send once the first is acknowledged", () => {
  checks.sendViolation(win, "External display detected", "high");
  checks.acknowledgeViolation(win.sent[0].id);
  checks.sendViolation(win, "Window minimize attempt", "high");

  mock.timers.tick(HARD_BLOCK_GRACE_MS);

  assert.deepStrictEqual(
    win.sent.map((m) => m.event),
    ["External display detected", "Window minimize attempt", "Window minimize attempt"]
  );
});

test("the interview page loading resends a hard block it may have missed", () => {
  checks.sendViolation(win, "External display detected", "high");
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 2);
  assert.strictEqual(win.sent[1].id, win.sent[0].id);
  assert.strictEqual(win.sent[1].redelivered, true);
});

test("a soft violation has no grace re-send but is redelivered on a page load", () => {
  checks.sendViolation(win, "Fullscreen exit attempt", "medium");
  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  assert.strictEqual(win.sent.length, 1);

  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 2);
  assert.strictEqual(win.sent[1].id, win.sent[0].id);
  assert.strictEqual(win.sent[1].isHardBlock, false);
});

test("nothing is resent once the interview has ended", () => {
  checks.sendViolation(win, "Blocked application running during interview: Zoom", "high");
  checks.stop();

  mock.timers.tick(HARD_BLOCK_GRACE_MS * 3);
  win.webContents.emit("did-finish-load");

  assert.strictEqual(win.sent.length, 1);
  assert.strictEqual(win.webContents.listenerCount("did-finish-load"), 0);
});
