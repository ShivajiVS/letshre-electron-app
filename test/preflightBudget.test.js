/**
 * Guards the preflight timing invariant. The original flakiness was arithmetic:
 * the renderer aborted every scan after 20s while main's worst case (cold agent
 * spawn + sequential 12s deep scan) was ~31s — fine on a warm machine, a retry
 * storm on a cold one.
 *
 * The renderer is sandboxed and can't require() shared constants, so its
 * budget is a literal; this test asserts that literal still agrees with
 * src/shared/constants.js.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  PREFLIGHT_HDMI_DEADLINE_MS,
  PREFLIGHT_PROCESS_DEADLINE_MS,
  PREFLIGHT_AGENT_DEADLINE_MS,
  PREFLIGHT_AGENT_SCAN_RESERVE_MS,
  PREFLIGHT_GLOBAL_DEADLINE_MS,
  PREFLIGHT_RENDERER_TIMEOUT_MS,
  AGENT_POLL_INTERVAL_MS,
  AGENT_READY_TIMEOUT_MS,
  AGENT_SCAN_TIMEOUT_MS,
} = require("../src/shared/constants");

test("every per-check deadline fits inside the global deadline", () => {
  for (const [name, ms] of [
    ["hdmi", PREFLIGHT_HDMI_DEADLINE_MS],
    ["process", PREFLIGHT_PROCESS_DEADLINE_MS],
    ["agent", PREFLIGHT_AGENT_DEADLINE_MS],
  ]) {
    assert.ok(
      ms <= PREFLIGHT_GLOBAL_DEADLINE_MS,
      `${name} deadline (${ms}ms) exceeds the global deadline (${PREFLIGHT_GLOBAL_DEADLINE_MS}ms)`
    );
  }
});

test("the renderer aborts strictly AFTER main's global deadline", () => {
  // Main must decide when a scan is over. If the renderer gives up first, it
  // abandons an invoke it can't cancel, and the orphaned scan keeps streaming
  // progress events into the next attempt.
  assert.ok(
    PREFLIGHT_RENDERER_TIMEOUT_MS > PREFLIGHT_GLOBAL_DEADLINE_MS,
    `renderer timeout (${PREFLIGHT_RENDERER_TIMEOUT_MS}ms) must exceed ` +
      `the global deadline (${PREFLIGHT_GLOBAL_DEADLINE_MS}ms)`
  );
});

test("the agent budget leaves real time BOTH to wait for spawn and to scan", () => {
  // scanAgent() polls for the agent to exist until (deadline - RESERVE), then
  // spends the reserve on the deep scan. If the reserve ever consumed the whole
  // budget, the liveness wait would go to zero — back to the original bug of an
  // instant "Security agent failed to start" while the agent was still spawning.
  const livenessWindow = PREFLIGHT_AGENT_DEADLINE_MS - PREFLIGHT_AGENT_SCAN_RESERVE_MS;
  assert.ok(
    livenessWindow > 0,
    `scan reserve (${PREFLIGHT_AGENT_SCAN_RESERVE_MS}ms) must leave time to wait ` +
      `for the agent within the ${PREFLIGHT_AGENT_DEADLINE_MS}ms budget`
  );
  // A cold spawn costs killStaleAgent (~1.5-2.5s) plus a PyInstaller unpack
  // (2-5s); the wait window must clear that comfortably.
  assert.ok(
    livenessWindow >= 8000,
    `only ${livenessWindow}ms to wait for a cold agent spawn — too tight`
  );
  // And the wait must fit several poll attempts, not just one.
  assert.ok(
    livenessWindow / AGENT_POLL_INTERVAL_MS >= 4,
    "the liveness wait should allow multiple poll attempts"
  );
});

test("the agent budget is exactly its two halves — spawn wait plus deep scan", () => {
  // scanAgent() spends (deadline - RESERVE) waiting for readiness and the
  // RESERVE on the scan. Both halves have their own authoritative constant, so
  // the deadline must be their sum: any other value silently over- or
  // under-funds one of them, which is how the liveness wait got starved before.
  assert.strictEqual(
    PREFLIGHT_AGENT_DEADLINE_MS,
    AGENT_READY_TIMEOUT_MS + AGENT_SCAN_TIMEOUT_MS,
    "agent deadline must equal the readiness budget plus the scan budget"
  );
  assert.strictEqual(
    PREFLIGHT_AGENT_SCAN_RESERVE_MS,
    AGENT_SCAN_TIMEOUT_MS,
    "the reserve must match the scan's own timeout, or withDeadline() cuts off " +
      "a scan agentClient is still waiting on"
  );
  // The liveness half must be the full readiness budget — not a shortened one.
  assert.strictEqual(
    PREFLIGHT_AGENT_DEADLINE_MS - PREFLIGHT_AGENT_SCAN_RESERVE_MS,
    AGENT_READY_TIMEOUT_MS
  );
});

test("agentClient's request timeouts come from the shared constants", () => {
  // These lived as literals in agentClient.js and drifted from the preflight
  // budget that has to contain them.
  const src = fs.readFileSync(path.join(__dirname, "../src/detector/agentClient.js"), "utf8");
  assert.match(src, /AGENT_REQUEST_TIMEOUT_MS: TIMEOUT_MS/);
  assert.match(src, /AGENT_SCAN_TIMEOUT_MS: SCAN_TIMEOUT_MS/);
});

test("preflight.js SCAN_TIMEOUT_MS still mirrors PREFLIGHT_RENDERER_TIMEOUT_MS", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/renderer/preflight.js"),
    "utf8"
  );
  const match = src.match(/const SCAN_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
  assert.ok(match, "could not find SCAN_TIMEOUT_MS in src/renderer/preflight.js");
  assert.strictEqual(
    Number(match[1]),
    PREFLIGHT_RENDERER_TIMEOUT_MS,
    "renderer SCAN_TIMEOUT_MS drifted from PREFLIGHT_RENDERER_TIMEOUT_MS"
  );
});
