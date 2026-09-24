"use strict";

const test = require("node:test");
const assert = require("node:assert");

const blocklist = require("../src/shared/blocklist");
const { IPC } = require("../src/shared/constants");
const { loadSystemChecks, CLEAN_AGENT } = require("./_preflightHarness");

const renamed = (original, pid) => ({
  type: "renamed_blocked_app",
  severity: "HIGH",
  detail: "Renamed blocked app",
  process: `x${pid}.exe`,
  pid,
  original,
});
const agentWith = (threats, extra = {}) => ({
  ...CLEAN_AGENT(),
  threats,
  safe_to_proceed: threats.length === 0,
  ...extra,
});
const allow = (names) => blocklist.applyPolicy(blocklist.validatePolicy({ allow: names }));

test.afterEach(() => blocklist.resetPolicy());

test("filterAgentStatus drops renamed copies of allowed apps and re-decides safe_to_proceed", () => {
  allow(["zoom.exe"]);
  const out = blocklist.filterAgentStatus(agentWith([renamed("zoom.exe", 44)]));
  assert.deepStrictEqual(out.threats, []);
  assert.strictEqual(out.safe_to_proceed, true);
});

test("filterAgentStatus keeps everything the effective list still blocks", () => {
  allow(["zoom.exe", "cluely.exe"]);
  const remote = { type: "remote_session", severity: "HIGH", detail: "Remote desktop" };
  const out = blocklist.filterAgentStatus(
    agentWith([renamed("zoom.exe", 1), renamed("cluely.exe", 2), renamed("teams.exe", 3), remote])
  );
  assert.deepStrictEqual(
    out.threats.map((t) => t.original ?? t.type),
    ["cluely.exe", "teams.exe", "remote_session"]
  );
  assert.strictEqual(out.safe_to_proceed, false);
});

test("filterAgentStatus leaves a degraded scan unsafe", () => {
  allow(["zoom.exe"]);
  const out = blocklist.filterAgentStatus(agentWith([renamed("zoom.exe", 1)], { degraded: true }));
  assert.deepStrictEqual(out.threats, []);
  assert.strictEqual(out.safe_to_proceed, false);
});

test("filterAgentStatus returns the status untouched without a policy", () => {
  const status = agentWith([renamed("zoom.exe", 1)]);
  assert.strictEqual(blocklist.filterAgentStatus(status), status);
  assert.strictEqual(blocklist.filterAgentStatus(null), null);
  assert.deepStrictEqual(blocklist.filterAgentStatus({ error: "x" }), { error: "x" });
});

test("preflight: an allowed renamed app neither fails the agent card nor becomes killable", async () => {
  const { checks, fake, unload } = loadSystemChecks();
  try {
    fake.scan = async () => agentWith([renamed("zoom.exe", 44)]);

    let result = await checks.runChecksOnce(null);
    let agent = result.verdicts.find((v) => v.id === "agent");
    assert.strictEqual(agent.status, "fail");
    assert.strictEqual(checks.getThreatProcesses().get(44), "x44.exe");

    allow(["zoom.exe"]);
    result = await checks.runChecksOnce(null);
    agent = result.verdicts.find((v) => v.id === "agent");
    assert.strictEqual(agent.status, "pass");
    assert.strictEqual(result.canProceed, true);
    assert.strictEqual(checks.getThreatProcesses().size, 0);
  } finally {
    unload();
  }
});

test("preflight: a renamed AI tool still fails even when the policy tries to allow it", async () => {
  const { checks, fake, unload } = loadSystemChecks();
  try {
    allow(["cluely.exe", "zoom.exe"]);
    fake.scan = async () => agentWith([renamed("zoom.exe", 1), renamed("cluely.exe", 2)]);
    const result = await checks.runChecksOnce(null);
    const agent = result.verdicts.find((v) => v.id === "agent");
    assert.strictEqual(agent.status, "fail");
    assert.deepStrictEqual(
      agent.threats.map((t) => t.original),
      ["cluely.exe"]
    );
    assert.deepStrictEqual([...checks.getThreatProcesses().keys()], [2]);
  } finally {
    unload();
  }
});

function sessionWin() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      on: () => {},
      removeListener: () => {},
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

async function tick(status) {
  const { checks, fake, unload } = loadSystemChecks();
  const win = sessionWin();
  try {
    fake.status = async () => status;
    checks.start(win);
    await checks._internal.runDetectionTick(win);
    return win.sent.filter((m) => m.channel === IPC.PUSH_VIOLATION);
  } finally {
    checks.stop();
    unload();
  }
}

test("live tick: an allowed renamed app raises no violation", async () => {
  allow(["zoom.exe"]);
  assert.deepStrictEqual(await tick(agentWith([renamed("zoom.exe", 44)])), []);
});

test("live tick: a renamed app still blocked raises a violation", async () => {
  allow(["zoom.exe"]);
  const pushed = await tick(agentWith([renamed("zoom.exe", 1), renamed("cluely.exe", 2)]));
  assert.strictEqual(pushed.length, 1);
  assert.strictEqual(pushed[0].payload.severity, "high");
});
