"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert");

const { loadSystemChecks } = require("./_preflightHarness");
const { AGENT_RESTART_AFTER_FAILURES } = require("../src/shared/constants");

let h;
afterEach(() => {
  h?.unload();
  h = null;
});

const agentCard = (result) => result.verdicts.find((v) => v.id === "agent");

test("two failed agent scans in a row make the next scan restart the agent", async () => {
  h = loadSystemChecks();
  h.fake.agentReady = async () => false;

  for (let i = 0; i < AGENT_RESTART_AFTER_FAILURES; i++) {
    await h.checks.runChecksOnce();
  }
  assert.strictEqual(h.fake.restarts, 0, "no restart before the streak is reached");

  await h.checks.runChecksOnce();
  assert.strictEqual(h.fake.restarts, 1);
});

test("an agent that is alive but returns no scan counts as a failure", async () => {
  h = loadSystemChecks();
  h.fake.scan = async () => null;
  await h.checks.runChecksOnce();
  await h.checks.runChecksOnce();
  assert.strictEqual(h.checks._internal.agentFailStreak(), 2);
  await h.checks.runChecksOnce();
  assert.strictEqual(h.fake.restarts, 1);
});

test("a successful agent scan resets the streak", async () => {
  h = loadSystemChecks();
  h.fake.agentReady = async () => false;
  await h.checks.runChecksOnce();
  await h.checks.runChecksOnce();

  h.fake.agentReady = async () => true;
  const recovered = await h.checks.runChecksOnce();
  assert.strictEqual(h.fake.restarts, 1);
  assert.strictEqual(agentCard(recovered).status, "pass");
  assert.strictEqual(h.checks._internal.agentFailStreak(), 0);

  await h.checks.runChecksOnce();
  assert.strictEqual(h.fake.restarts, 1, "a healthy agent is not restarted again");
});

test("scans from a page that was left don't count towards the streak", async () => {
  h = loadSystemChecks();
  h.fake.agentReady = async () => false;
  for (let i = 0; i < 3; i++) {
    await h.checks.runChecksOnce(null, { isCurrent: () => false });
  }
  assert.strictEqual(h.checks._internal.agentFailStreak(), 0);
  assert.strictEqual(h.fake.restarts, 0);
});

test("an agent that can't be started at all fails with agentBlocked", async () => {
  h = loadSystemChecks();
  h.fake.agentReady = async () => false;
  h.fake.blocked = true;
  const result = await h.checks.runChecksOnce();
  assert.strictEqual(agentCard(result).status, "fail");
  assert.strictEqual(agentCard(result).reasonKey, "preflightResults.agentBlocked");
});

test("an agent that is merely down still reads as failed to start", async () => {
  h = loadSystemChecks();
  h.fake.agentReady = async () => false;
  const result = await h.checks.runChecksOnce();
  assert.strictEqual(agentCard(result).reasonKey, "preflightResults.agentFailedStart");
});

test("auto-respawn backs off 2s, 4s, 8s … up to 30s, and resets after a stable run", () => {
  const { _internal } = require("../src/main/agentManager");
  _internal.resetBackoff();
  const crashes = Array.from({ length: 7 }, () => _internal.nextRespawnDelay(500));
  assert.deepStrictEqual(crashes, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);

  assert.strictEqual(_internal.nextRespawnDelay(60000), 2000, "a minute of uptime resets it");
  assert.strictEqual(_internal.nextRespawnDelay(100), 4000);
  _internal.resetBackoff();
});

test("with no agent process there is no startup grace to respect", () => {
  const { _internal } = require("../src/main/agentManager");
  assert.strictEqual(_internal.inStartupGrace(), false);
});
