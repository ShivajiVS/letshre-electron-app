"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert");

const { killThreatProcess } = require("../src/main/processKiller");
const { loadSystemChecks, CLEAN_AGENT } = require("./_preflightHarness");

const FAST_TIMING = {
  enumTimeoutMs: 1,
  verifyTimeoutMs: 1,
  verifyPollMs: 1,
  relaunchWatchMs: 1,
  relaunchPollMs: 1,
};

function fakeDeps(overrides) {
  const killed = [];
  return {
    killed,
    platform: "win32",
    selfPid: 1000,
    timing: FAST_TIMING,
    sleep: async () => {},
    listProcessTable: async () => ({
      ok: true,
      procs: [
        { pid: 1000, ppid: 900, name: "electron.exe", created: 100 },
        { pid: 4242, ppid: 1, name: "overlay.exe", created: 100 },
      ],
    }),
    findPidsByName: async () => ({ ok: true, pids: [] }),
    killPid: async (pid) => {
      killed.push(pid);
      return { status: "killed" };
    },
    ...(overrides || {}),
  };
}

const ALLOWED = new Map([[4242, "overlay.exe"]]);

test("a reported threat PID running the reported image is killed", async () => {
  const deps = fakeDeps();
  const r = await killThreatProcess(4242, "Overlay.exe", ALLOWED, deps);
  assert.strictEqual(r.outcome, "closed");
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.pid, 4242);
  assert.deepStrictEqual(deps.killed, [4242]);
});

test("a PID the agent never reported is refused", async () => {
  const deps = fakeDeps();
  const r = await killThreatProcess(5555, "overlay.exe", ALLOWED, deps);
  assert.strictEqual(r.outcome, "not-blocked");
  assert.strictEqual(r.success, false);
  assert.deepStrictEqual(deps.killed, []);
});

test("a reported PID claimed under a different name is refused", async () => {
  const deps = fakeDeps();
  const r = await killThreatProcess(4242, "explorer.exe", ALLOWED, deps);
  assert.strictEqual(r.outcome, "not-blocked");
  assert.deepStrictEqual(deps.killed, []);
});

test("a reported PID that now runs a different image is refused", async () => {
  const deps = fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [{ pid: 4242, ppid: 1, name: "notepad.exe", created: 100 }],
    }),
  });
  const r = await killThreatProcess(4242, "overlay.exe", ALLOWED, deps);
  assert.strictEqual(r.outcome, "not-blocked");
  assert.deepStrictEqual(deps.killed, []);
});

test("malformed PIDs are refused before anything is listed", async () => {
  for (const pid of [0, -1, 1.5, "4242", null, undefined, NaN]) {
    let listed = false;
    const deps = fakeDeps({
      listProcessTable: async () => {
        listed = true;
        return { ok: false, procs: [] };
      },
    });
    const r = await killThreatProcess(pid, "overlay.exe", ALLOWED, deps);
    assert.strictEqual(r.outcome, "not-blocked", String(pid));
    assert.strictEqual(listed, false);
  }
});

test("an empty process table fails closed; an exited PID is already-gone", async () => {
  const deps = fakeDeps({ listProcessTable: async () => ({ ok: true, procs: [] }) });
  assert.strictEqual(
    (await killThreatProcess(4242, "overlay.exe", ALLOWED, deps)).outcome,
    "spawn-error",
    "an empty table can't be trusted"
  );
  const gone = fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [{ pid: 1000, ppid: 900, name: "electron.exe", created: 100 }],
    }),
  });
  assert.strictEqual(
    (await killThreatProcess(4242, "overlay.exe", ALLOWED, gone)).outcome,
    "already-gone"
  );
});

test("our own process tree is never killed, even if reported", async () => {
  const deps = fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [
        { pid: 1000, ppid: 900, name: "electron.exe", created: 100 },
        { pid: 4242, ppid: 1000, name: "overlay.exe", created: 200 },
      ],
    }),
  });
  const r = await killThreatProcess(4242, "overlay.exe", ALLOWED, deps);
  assert.strictEqual(r.outcome, "own-process");
  assert.deepStrictEqual(deps.killed, []);
});

test("a denied kill and a survivor are reported as such", async () => {
  const denied = fakeDeps({ killPid: async () => ({ status: "denied", detail: "no" }) });
  assert.strictEqual(
    (await killThreatProcess(4242, "overlay.exe", ALLOWED, denied)).outcome,
    "access-denied"
  );
  const survivor = fakeDeps({ findPidsByName: async () => ({ ok: true, pids: [4242] }) });
  assert.strictEqual(
    (await killThreatProcess(4242, "overlay.exe", ALLOWED, survivor)).outcome,
    "still-running"
  );
});

let h;
afterEach(() => {
  h?.unload();
  h = null;
});

test("the allowed set comes from the latest agent scan that came back", async () => {
  h = loadSystemChecks();
  h.fake.scan = async () => ({
    ...CLEAN_AGENT(),
    safe_to_proceed: false,
    threats: [
      { type: "overlay", severity: "HIGH", process: "Overlay.exe", pid: 4242 },
      { type: "network", severity: "LOW" },
      { type: "bad", process: "x.exe", pid: -3 },
    ],
  });
  await h.checks.runChecksOnce();
  assert.deepStrictEqual([...h.checks.getThreatProcesses()], [[4242, "overlay.exe"]]);

  h.fake.scan = async () => null;
  await h.checks.runChecksOnce();
  assert.deepStrictEqual(
    [...h.checks.getThreatProcesses()],
    [[4242, "overlay.exe"]],
    "a scan that didn't come back keeps the previous report"
  );

  h.fake.scan = async () => CLEAN_AGENT();
  await h.checks.runChecksOnce();
  assert.strictEqual(h.checks.getThreatProcesses().size, 0);
});
