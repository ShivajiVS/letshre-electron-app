"use strict";

// What the live session attaches to the violations it pushes, and display
// changes mid-interview.

const { test, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const axios = require("axios");

const { loadSystemChecks } = require("./_preflightHarness");
const { IPC } = require("../src/shared/constants");
const { CODE } = require("../src/shared/violationCodes");
const logger = require("../src/main/logger");

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function fakeWin() {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, payload });
  return { webContents, sent, isDestroyed: () => false };
}

let h;
let win;
let backendPosts;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  backendPosts = [];
  mock.method(axios, "post", async (url) => {
    backendPosts.push(url);
    return { data: {} };
  });
  h = loadSystemChecks();
  win = fakeWin();
});

afterEach(() => {
  h.unload();
  mock.restoreAll();
  mock.timers.reset();
});

const pushed = () => win.sent.filter((m) => m.channel === IPC.PUSH_VIOLATION).map((m) => m.payload);

async function startSession() {
  h.checks.start(win);
  await settle();
}

function raise(event = "Attempt to close interview window") {
  h.checks.sendViolation(win, event, "high", { code: CODE.CLOSE_ATTEMPT });
}

// ─── Session ids, app version, recording offset ──────────────────────────────

test("a violation carries the session ids, app version and recording offset", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  h.fake.recordingOffsetMs = 61250;
  raise();
  await settle();

  const [violation] = pushed();
  assert.strictEqual(violation.sessionId, "sess-1");
  assert.strictEqual(violation.interviewId, "int-9");
  assert.strictEqual(violation.recordingOffsetMs, 61250);
  assert.ok("appVersion" in violation);
});

test("a violation raised before the site sent its ids gets them on redelivery", async () => {
  await startSession();
  raise();
  await settle();
  assert.strictEqual(pushed()[0].sessionId, null);
  assert.strictEqual(pushed()[0].recordingOffsetMs, null);

  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  win.webContents.emit("did-finish-load");

  const redelivered = pushed().at(-1);
  assert.strictEqual(redelivered.redelivered, true);
  assert.strictEqual(redelivered.sessionId, "sess-1");
  assert.strictEqual(redelivered.interviewId, "int-9");
});

test("the session ids are forgotten when the session ends", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  assert.strictEqual(logger.getSessionId(), "sess-1");
  h.checks.stop();
  assert.strictEqual(logger.getSessionId(), null);

  await startSession();
  raise("Fullscreen exit attempt");
  await settle();
  assert.strictEqual(pushed().at(-1).sessionId, null);
});

test("audit events carry the run id and session id", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  raise();

  const entry = h.checks.getAuditLog().find((e) => e.type === "violation");
  assert.strictEqual(entry.runId, logger.runId);
  assert.strictEqual(entry.sessionId, "sess-1");
});

test("a session posts nothing to the backend: no heartbeat, no violation reports", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  raise();
  mock.timers.tick(60_000);
  await settle();
  h.checks.stop();
  await settle();
  assert.deepStrictEqual(backendPosts, []);
});

// ─── Display changes during the interview ───────────────────────────────────

test("a display change mid-interview runs one debounced detection tick", async () => {
  let probes = 0;
  h.fake.hdmi = async () => {
    probes += 1;
    return { detected: false, status: "clear", count: 1, monitors: [] };
  };
  await startSession();
  const before = probes;

  h.screen.emit("display-added");
  h.screen.emit("display-removed");
  h.screen.emit("display-added");
  mock.timers.tick(299);
  await settle();
  assert.strictEqual(probes, before, "still waiting out the debounce");

  mock.timers.tick(1);
  await settle();
  assert.strictEqual(probes, before + 1, "one tick for the burst");
});

test("a display plugged in mid-interview is reported within a second", async () => {
  await startSession();
  h.fake.hdmi = async () => ({
    detected: true,
    status: "violation",
    count: 2,
    reason: "External display detected (2 displays)",
  });

  h.screen.emit("display-added");
  mock.timers.tick(300);
  await settle();

  assert.ok(pushed().some((p) => p.code === CODE.EXTERNAL_DISPLAY));
});

test("stopping the session removes its display listeners", async () => {
  await startSession();
  assert.strictEqual(h.screen.listenerCount("display-added"), 1);
  h.checks.start(win);
  assert.strictEqual(h.screen.listenerCount("display-added"), 1, "never registered twice");

  h.checks.stop();
  assert.strictEqual(h.screen.listenerCount("display-added"), 0);
  assert.strictEqual(h.screen.listenerCount("display-removed"), 0);
});
