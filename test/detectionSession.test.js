"use strict";

// What the live session attaches to its reports, how unsent reports are
// retried and kept across a restart, and display changes mid-interview.

const { test, mock, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const axios = require("axios");

const { loadSystemChecks } = require("./_preflightHarness");
const { HEARTBEAT_INTERVAL_MS } = require("../src/shared/constants");
const { CODE } = require("../src/shared/violationCodes");
const logger = require("../src/main/logger");

const PROTOCOL_HANDLER = require.resolve("../src/main/protocolHandler");
const REPORT_STORE = require.resolve("../src/main/reportStore");
require.cache[PROTOCOL_HANDLER] = {
  id: PROTOCOL_HANDLER,
  filename: PROTOCOL_HANDLER,
  loaded: true,
  exports: { getCurrentAccessToken: () => "token" },
};
after(() => delete require.cache[PROTOCOL_HANDLER]);

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function fakeWin() {
  const webContents = new EventEmitter();
  webContents.send = () => {};
  return { webContents, isDestroyed: () => false };
}

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

let h;
let win;
let posts;
let heartbeats;
let respond;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  posts = [];
  heartbeats = [];
  respond = async () => ({ data: {} });
  mock.method(axios, "post", async (url, body) => {
    if (url.endsWith("/interview/heartbeat")) {
      heartbeats.push(body);
      return { data: {} };
    }
    posts.push(body);
    return respond(body);
  });
  h = loadSystemChecks();
  win = fakeWin();
});

afterEach(() => {
  h.unload();
  mock.restoreAll();
  mock.timers.reset();
});

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

  const [posted] = posts;
  assert.strictEqual(posted.sessionId, "sess-1");
  assert.strictEqual(posted.interviewId, "int-9");
  assert.strictEqual(posted.recordingOffsetMs, 61250);
  assert.ok("appVersion" in posted);
});

test("a violation raised before the site sent its ids gets them while still queued", async () => {
  respond = async () => {
    throw new Error("socket hang up");
  };
  await startSession();
  raise();
  await settle();
  assert.strictEqual(posts[0].sessionId, null);
  assert.strictEqual(posts[0].recordingOffsetMs, null);

  respond = async () => ({ data: {} });
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  await h.checks._internal.flushReports();

  const delivered = posts.at(-1);
  assert.strictEqual(delivered.sessionId, "sess-1");
  assert.strictEqual(delivered.interviewId, "int-9");
  assert.deepStrictEqual(h.checks._internal.pendingReports(), []);
});

test("the heartbeat carries the session ids and app version", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  await settle();

  assert.strictEqual(heartbeats.length, 1);
  assert.strictEqual(heartbeats[0].sessionId, "sess-1");
  assert.strictEqual(heartbeats[0].interviewId, "int-9");
  assert.ok("appVersion" in heartbeats[0]);
  assert.ok(!Number.isNaN(Date.parse(heartbeats[0].timestamp)));
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
  assert.strictEqual(posts.at(-1).sessionId, null);
});

test("audit events carry the run id and session id", async () => {
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  raise();

  const entry = h.checks.getAuditLog().find((e) => e.type === "violation");
  assert.strictEqual(entry.runId, logger.runId);
  assert.strictEqual(entry.sessionId, "sess-1");
});

// ─── Retry ───────────────────────────────────────────────────────────────────

test("a network error keeps the report and retries with growing backoff", async () => {
  respond = async () => {
    throw new Error("ECONNRESET");
  };
  await startSession();
  raise();
  await settle();
  assert.strictEqual(posts.length, 1);

  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 2, "first retry after 2s");

  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 2, "the second wait is longer");

  respond = async () => ({ data: {} });
  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 3);
  assert.deepStrictEqual(h.checks._internal.pendingReports(), []);
});

for (const status of [500, 503, 408, 429, 401]) {
  test(`a ${status} keeps the report queued`, async () => {
    respond = async () => {
      throw httpError(status);
    };
    await startSession();
    raise();
    await settle();
    assert.strictEqual(h.checks._internal.pendingReports().length, 1);
  });
}

for (const status of [400, 403, 404, 422]) {
  test(`a ${status} drops that report and lets the next one through`, async () => {
    const warn = mock.method(logger, "warn");
    await startSession();
    respond = async (body) => {
      if (body.event === "Attempt to close interview window") {
        throw httpError(status);
      }
      return { data: {} };
    };
    // Queue both before the first post settles.
    raise();
    raise("Fullscreen exit attempt");
    await settle();

    assert.deepStrictEqual(
      posts.map((p) => p.event),
      ["Attempt to close interview window", "Fullscreen exit attempt"]
    );
    assert.deepStrictEqual(h.checks._internal.pendingReports(), []);
    assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes(`(${status})`)));
  });
}

// ─── Persistence ─────────────────────────────────────────────────────────────

test("unsent reports survive a restart and are sent after the next launch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
  const key = crypto.randomBytes(32);
  const reportStore = require(REPORT_STORE);
  reportStore.init(dir, key);
  t.after(() => {
    delete require.cache[REPORT_STORE];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  respond = async () => {
    throw new Error("offline");
  };
  await startSession();
  h.checks.setSessionContext({ sessionId: "sess-1", interviewId: "int-9" });
  raise();
  await settle();
  const unsent = h.checks._internal.pendingReports()[0];
  assert.deepStrictEqual(reportStore.load(), [unsent]);

  // Quit and relaunch.
  h.unload();
  h = loadSystemChecks();
  posts = [];
  respond = async () => ({ data: {} });

  assert.strictEqual(h.checks.restorePendingReports(), 1);
  await settle();

  assert.deepStrictEqual(posts, [unsent]);
  assert.deepStrictEqual(reportStore.load(), []);
  assert.ok(!fs.existsSync(path.join(dir, reportStore.FILE_NAME)));
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

  assert.ok(posts.some((p) => p.code === CODE.EXTERNAL_DISPLAY));
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
