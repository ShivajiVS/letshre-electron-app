"use strict";

const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const { loadSystemChecks, fakeWin } = require("./_preflightHarness");
const { IPC, PREFLIGHT_RESULT_MAX_AGE_MS } = require("../src/shared/constants");

let h;
afterEach(() => {
  mock.timers.reset();
  h?.unload();
  h = null;
});

const pushes = (win) =>
  win.sent.filter((m) => m.channel === IPC.PUSH_PRE_PROCEED_STATUS).map((m) => m.payload);

async function passedWithMonitor() {
  h = loadSystemChecks();
  const result = await h.checks.runChecksOnce();
  assert.strictEqual(result.canProceed, true);
  const win = fakeWin();
  h.checks.startPreProceedMonitor(win);
  return win;
}

test("a clean pass opens the gate", async () => {
  await passedWithMonitor();
  assert.deepStrictEqual(h.checks.verifyProceedAllowed(), { ok: true, code: "none", reason: "" });
});

test("a blocked app seen by the live monitor closes the gate, and a clean tick reopens it", async () => {
  const win = await passedWithMonitor();

  h.fake.processes = async () => ({ found: ["zoom.exe"], status: "clear" });
  await h.checks._internal.monitorTick();
  assert.strictEqual(h.checks.verifyProceedAllowed().code, "dirty");

  const dirty = pushes(win).at(-1);
  assert.strictEqual(dirty.clean, false);
  assert.strictEqual(dirty.unverified, false);
  assert.deepStrictEqual(dirty.apps, ["zoom.exe"]);
  assert.deepStrictEqual(
    dirty.verdicts.map((v) => v.id),
    ["hdmi", "meeting", "screen", "wireless", "browser", "ai"]
  );
  assert.strictEqual(dirty.verdicts.find((v) => v.id === "meeting").status, "fail");

  h.fake.processes = async () => ({ found: [], status: "clear" });
  await h.checks._internal.monitorTick();
  assert.strictEqual(h.checks.verifyProceedAllowed().ok, true);
  assert.strictEqual(pushes(win).at(-1).clean, true);
});

test("an indeterminate live probe is unverified, not clean", async () => {
  const win = await passedWithMonitor();
  h.fake.processes = async () => ({ found: [], status: "indeterminate" });
  await h.checks._internal.monitorTick();

  const payload = pushes(win).at(-1);
  assert.strictEqual(payload.clean, false);
  assert.strictEqual(payload.unverified, true);
  assert.strictEqual(h.checks.verifyProceedAllowed().code, "dirty");
});

test("an extra display seen live closes the gate", async () => {
  const win = await passedWithMonitor();
  h.fake.hdmi = async () => ({ detected: true, status: "violation", count: 2 });
  await h.checks._internal.monitorTick();
  assert.strictEqual(pushes(win).at(-1).clean, false);
  assert.strictEqual(h.checks.verifyProceedAllowed().code, "dirty");
});

test("live state never affects requireFresh=false callers", async () => {
  await passedWithMonitor();
  h.fake.processes = async () => ({ found: ["zoom.exe"], status: "clear" });
  await h.checks._internal.monitorTick();
  assert.deepStrictEqual(h.checks.verifyProceedAllowed({ requireFresh: false }), {
    ok: true,
    code: "none",
    reason: "",
  });
});

test("stopping the monitor clears its live state", async () => {
  await passedWithMonitor();
  h.fake.processes = async () => ({ found: ["zoom.exe"], status: "clear" });
  await h.checks._internal.monitorTick();
  h.checks.stopPreProceedMonitor();
  assert.strictEqual(h.checks.verifyProceedAllowed().ok, true);
});

test("a tick that outlives the monitor is dropped", async () => {
  const win = await passedWithMonitor();
  let release;
  h.fake.processes = () =>
    new Promise((resolve) => {
      release = () => resolve({ found: ["zoom.exe"], status: "clear" });
    });
  const tick = h.checks._internal.monitorTick();
  h.checks.stopPreProceedMonitor();
  release();
  await tick;
  assert.strictEqual(pushes(win).length, 0);
  assert.strictEqual(h.checks.verifyProceedAllowed().ok, true);
});

test("display changes push immediately while the monitor runs, and not after it stops", async () => {
  const win = await passedWithMonitor();
  assert.strictEqual(h.screen.listenerCount("display-added"), 1);
  assert.strictEqual(h.screen.listenerCount("display-removed"), 1);

  h.fake.hdmi = async () => ({ detected: true, status: "violation", count: 2 });
  h.screen.emit("display-added");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pushes(win).length, 1);
  assert.strictEqual(pushes(win)[0].clean, false);

  h.checks.stopPreProceedMonitor();
  assert.strictEqual(h.screen.listenerCount("display-added"), 0);
  assert.strictEqual(h.screen.listenerCount("display-removed"), 0);
});

test("a scan of the current page blocks Continue; an orphaned one does not", async () => {
  h = loadSystemChecks();
  await h.checks.runChecksOnce();

  let release;
  h.fake.scan = () => new Promise((resolve) => (release = resolve));
  let current = true;
  const running = h.checks.runChecksOnce(null, { isCurrent: () => current });
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(h.checks.verifyProceedAllowed().code, "scanning");
  assert.strictEqual(h.checks.verifyProceedAllowed({ requireFresh: false }).ok, true);

  current = false;
  assert.notStrictEqual(h.checks.verifyProceedAllowed().code, "scanning");

  release(null);
  await running;
});

test("an orphaned scan finishes but never commits its result", async () => {
  h = loadSystemChecks();
  const result = await h.checks.runChecksOnce(null, { isCurrent: () => false });
  assert.strictEqual(result.canProceed, true);
  assert.strictEqual(h.checks.verifyProceedAllowed({ requireFresh: false }).code, "failed");
});

test("an orphaned failing scan can't overwrite the current pass either", async () => {
  h = loadSystemChecks();
  await h.checks.runChecksOnce();
  h.fake.processes = async () => ({ found: ["zoom.exe"], status: "clear" });
  const orphan = await h.checks.runChecksOnce(null, { isCurrent: () => false });
  assert.strictEqual(orphan.canProceed, false);
  assert.strictEqual(h.checks.verifyProceedAllowed().ok, true);
});

test("the token is echoed on every progress event and on the result", async () => {
  h = loadSystemChecks();
  const events = [];
  const result = await h.checks.runChecksOnce((p) => events.push(p), { token: "scan-abc-1" });
  assert.strictEqual(result.token, "scan-abc-1");
  assert.ok(events.length >= 7);
  assert.ok(events.every((e) => e.token === "scan-abc-1" && e.scanId === result.scanId));
});

test("capturedAt is when the earliest probe finished, and expiresAt follows it", async () => {
  h = loadSystemChecks();
  h.fake.scan = () => new Promise((resolve) => setTimeout(() => resolve(h.fake.status()), 80));
  const before = Date.now();
  const result = await h.checks.runChecksOnce();
  const after = Date.now();
  assert.ok(after - before >= 70, "the agent probe should have held the scan open");
  assert.ok(result.capturedAt - before < 50, "capturedAt must not be the scan end");
  assert.strictEqual(result.expiresAt, result.capturedAt + PREFLIGHT_RESULT_MAX_AGE_MS);
});

test("a mirrored display fails the hdmi card with the physical count", async () => {
  h = loadSystemChecks();
  h.fake.scan = async () => ({ ...(await h.fake.status()), physical_monitors: 2 });
  const result = await h.checks.runChecksOnce();
  const hdmi = result.verdicts.find((v) => v.id === "hdmi");
  assert.strictEqual(hdmi.reasonKey, "preflightResults.hdmiMirrored");
  assert.deepStrictEqual(hdmi.reasonParams, { count: 2 });
  assert.strictEqual(result.canProceed, false);
});

test("a stale pass is renewed when a quick re-check is clean", async () => {
  h = loadSystemChecks();
  await h.checks.runChecksOnce();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + PREFLIGHT_RESULT_MAX_AGE_MS + 1000 });
  assert.strictEqual(h.checks.verifyProceedAllowed().code, "stale");
  assert.strictEqual(await h.checks.renewStalePass(), true);
  assert.strictEqual(h.checks.verifyProceedAllowed().ok, true);
});

test("a stale pass is not renewed when the re-check finds a problem", async () => {
  for (const problem of [
    (f) => (f.processes = async () => ({ found: ["zoom.exe"], status: "clear" })),
    (f) => (f.hdmi = async () => ({ detected: true, status: "violation", count: 2 })),
    (f) => (f.status = async () => null),
    (f) => (f.status = async () => ({ threats: [{ type: "x" }], degraded: false })),
    (f) => (f.status = async () => ({ threats: [], degraded: true })),
  ]) {
    h = loadSystemChecks();
    await h.checks.runChecksOnce();
    mock.timers.enable({ apis: ["Date"], now: Date.now() + PREFLIGHT_RESULT_MAX_AGE_MS + 1000 });
    problem(h.fake);
    assert.strictEqual(await h.checks.renewStalePass(), false);
    assert.strictEqual(h.checks.verifyProceedAllowed().code, "stale");
    mock.timers.reset();
    h.unload();
    h = null;
  }
});

test("renewal only applies to a pass whose sole problem is age", async () => {
  h = loadSystemChecks();
  h.fake.processes = async () => ({ found: ["zoom.exe"], status: "clear" });
  await h.checks.runChecksOnce();
  h.fake.processes = async () => ({ found: [], status: "clear" });
  assert.strictEqual(await h.checks.renewStalePass(), false);
  assert.strictEqual(h.checks.verifyProceedAllowed().code, "failed");
});
