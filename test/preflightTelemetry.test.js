"use strict";

const test = require("node:test");
const assert = require("node:assert");

const telemetry = require("../src/main/preflightTelemetry");
const { loadSystemChecks } = require("./_preflightHarness");

const config = telemetry._config;
const original = { ...config };

function capture({ fail = 0 } = {}) {
  const posts = [];
  let failures = fail;
  config.path = "/telemetry";
  config.getToken = () => "tok";
  config.sleep = async () => {};
  config.post = async (url, body, opts) => {
    posts.push({ url, body, opts });
    if (failures > 0) {
      failures -= 1;
      throw new Error("503");
    }
  };
  return posts;
}

test.afterEach(() => {
  Object.assign(config, original);
  telemetry._queue.length = 0;
});

const SCAN = {
  scanId: "abc-123",
  capturedAt: Date.parse("2026-09-24T10:00:00Z"),
  canProceed: false,
  durationMs: 1234,
  verdicts: [
    { id: "hdmi", status: "pass", reasonKey: "preflightResults.hdmiClear" },
    {
      id: "browser",
      status: "fail",
      reasonKey: "preflightResults.browserRunning",
      blockedApps: ["chrome.exe", "firefox.exe"],
    },
    {
      id: "agent",
      status: "fail",
      reasonKey: "preflightResults.agentThreatsDetected",
      reasonParams: { n: 2 },
      threats: [
        { type: "renamed_blocked_app", process: "notzoom.exe", pid: 44, detail: "C:\\Users\\jo" },
        { type: "remote_session", detail: "RDP" },
        { type: "renamed_blocked_app", process: "x.exe", pid: 45 },
      ],
    },
  ],
  timings: {
    display: { durationMs: 4, deadlineMs: 1000, outcome: "ok", timedOut: false },
    agent: { durationMs: 9000, deadlineMs: 22000, outcome: "timeout", timedOut: true },
  },
  agentStatus: { agent_version: "2.1.0", source_sha: "0123456789abcdef0123", threats: [] },
};

test("the payload is the allow-listed shape with no process names or paths", () => {
  const body = telemetry.buildPayload(SCAN);
  assert.deepStrictEqual(Object.keys(body).sort(), [
    "agentSource",
    "agentVersion",
    "appVersion",
    "arch",
    "canProceed",
    "capturedAt",
    "durationMs",
    "locale",
    "osRelease",
    "platform",
    "policyApplied",
    "scanId",
    "timings",
    "verdicts",
  ]);
  assert.strictEqual(body.capturedAt, "2026-09-24T10:00:00.000Z");
  assert.strictEqual(body.agentSource, "0123456789ab");
  assert.strictEqual(body.agentVersion, "2.1.0");
  assert.strictEqual(body.policyApplied, false);
  assert.deepStrictEqual(body.verdicts, [
    { id: "hdmi", status: "pass", reasonKey: "preflightResults.hdmiClear" },
    {
      id: "browser",
      status: "fail",
      reasonKey: "preflightResults.browserRunning",
      blockedCount: 2,
    },
    {
      id: "agent",
      status: "fail",
      reasonKey: "preflightResults.agentThreatsDetected",
      threatTypes: ["remote_session", "renamed_blocked_app"],
    },
  ]);
  assert.deepStrictEqual(body.timings, {
    display: { durationMs: 4, outcome: "ok" },
    agent: { durationMs: 9000, outcome: "timeout" },
  });
  const text = JSON.stringify(body);
  for (const leak of ["chrome.exe", "notzoom", "x.exe", "Users", "RDP", "pid"]) {
    assert.ok(!text.includes(leak), `payload leaks ${leak}`);
  }
});

test("posts with the bearer token and a 5s timeout", async () => {
  const posts = capture();
  await telemetry.recordScan(SCAN);
  assert.strictEqual(posts.length, 1);
  assert.match(posts[0].url, /\/telemetry$/);
  assert.strictEqual(posts[0].opts.headers.Authorization, "Bearer tok");
  assert.strictEqual(posts[0].opts.timeout, 5000);
});

test("disabled when the endpoint is unset", async () => {
  capture();
  config.path = "";
  config.post = async () => assert.fail("must not post");
  await telemetry.recordScan(SCAN);
  assert.strictEqual(telemetry._queue.length, 0);
});

test("retries up to three attempts, then drops", async () => {
  let posts = capture({ fail: 2 });
  await telemetry.recordScan(SCAN);
  assert.strictEqual(posts.length, 3, "third attempt succeeds");

  posts = capture({ fail: 10 });
  await telemetry.recordScan(SCAN);
  assert.strictEqual(posts.length, telemetry.MAX_ATTEMPTS);
  assert.strictEqual(telemetry._queue.length, 0);
});

test("the queue is bounded, dropping the oldest", async () => {
  const posts = capture();
  let release;
  config.getToken = () => "tok";
  config.post = async (url, body) => {
    posts.push(body.scanId);
    if (!release) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  };
  const first = telemetry.recordScan({ ...SCAN, scanId: "s0" });
  for (let i = 1; i <= 30; i++) {
    telemetry.recordScan({ ...SCAN, scanId: `s${i}` });
  }
  assert.strictEqual(telemetry._queue.length, telemetry.MAX_QUEUE);
  release();
  await first;
  assert.strictEqual(posts.length, 1 + telemetry.MAX_QUEUE);
  assert.strictEqual(posts[1], "s11");
  assert.strictEqual(posts.at(-1), "s30");
});

test("never throws into the scan, even when posting blows up", async () => {
  capture();
  config.getToken = () => {
    throw new Error("boom");
  };
  await assert.doesNotReject(telemetry.recordScan(SCAN));
});

test("only a committed scan is sent", async () => {
  const posts = capture();
  const { checks, unload } = loadSystemChecks();
  try {
    await checks.runChecksOnce(null, { isCurrent: () => false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(posts.length, 0, "an abandoned page's scan is not sent");

    const result = await checks.runChecksOnce(null, { isCurrent: () => true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].body.scanId, result.scanId);
    assert.strictEqual(posts[0].body.canProceed, result.canProceed);
  } finally {
    unload();
  }
});
