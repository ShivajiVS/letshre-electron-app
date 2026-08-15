/**
 * test/preflightBudget.test.js
 * ────────────────────────────
 * Guards the preflight timing invariant.
 *
 * The original flakiness was arithmetic, not logic: the renderer aborted every
 * scan after 20s while the main process's worst case (a cold agent spawn behind
 * ensureAgent, then a sequential 12s deep scan) was ~31s. On a warm machine the
 * scan took ~1s and everything worked; on a cold one it timed out every attempt
 * and fell into a retry storm. "Sometimes the checks don't work."
 *
 * The renderer cannot require() shared constants (preload is sandboxed, which is
 * also why IPC channel names are mirrored there), so its budget is a literal.
 * This test asserts that literal still agrees with src/shared/constants.js.
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
  PREFLIGHT_GLOBAL_DEADLINE_MS,
  PREFLIGHT_RENDERER_TIMEOUT_MS,
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
  // Main must always be the component that decides a scan is over. If the
  // renderer gives up first it abandons an invoke it cannot cancel, and the
  // orphaned scan keeps streaming progress events into the next attempt.
  assert.ok(
    PREFLIGHT_RENDERER_TIMEOUT_MS > PREFLIGHT_GLOBAL_DEADLINE_MS,
    `renderer timeout (${PREFLIGHT_RENDERER_TIMEOUT_MS}ms) must exceed ` +
      `the global deadline (${PREFLIGHT_GLOBAL_DEADLINE_MS}ms)`
  );
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
