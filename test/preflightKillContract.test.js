/**
 * The renderer half of the kill-result contract.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  normalizeKillResult,
  killOutcomeView,
  indexKillResults,
} = require("../src/renderer/preflightModel");

const PAGE_SOURCE = fs.readFileSync(path.join(__dirname, "../src/renderer/preflight.js"), "utf8");

test("the kill result normaliser carries serviceBacked through", () => {
  const norm = normalizeKillResult({ outcome: "respawned", serviceBacked: true }, "x.exe");
  assert.strictEqual(norm.serviceBacked, true);
  assert.strictEqual(normalizeKillResult({ outcome: "respawned" }, "x.exe").serviceBacked, false);
});

test("a recognised outcome decides success, not the success flag", () => {
  const norm = normalizeKillResult({ success: true, outcome: "respawned" }, "x.exe");
  assert.strictEqual(norm.success, false);
  assert.strictEqual(normalizeKillResult({ success: true }, "x.exe").success, true);
  assert.strictEqual(
    normalizeKillResult({ outcome: "bogus", success: false }, "x.exe").outcome,
    null
  );
  assert.strictEqual(normalizeKillResult(undefined, "x.exe").success, false);
});

test("a service-backed respawn offers the elevated retry", () => {
  // Only elevation stops the service. A user-level auto-start respawns regardless.
  const norm = normalizeKillResult({ outcome: "respawned", serviceBacked: true }, "x.exe");
  assert.strictEqual(killOutcomeView(norm, { canElevate: true }).view, "elevate");
  assert.strictEqual(killOutcomeView(norm, { canElevate: false }).view, "respawned");

  const userLevel = normalizeKillResult({ outcome: "respawned" }, "x.exe");
  assert.strictEqual(killOutcomeView(userLevel, { canElevate: true }).view, "respawned");
});

test("the elevated retry stays one-shot", () => {
  // Re-offering it loops a UAC prompt the candidate already declined.
  const respawn = normalizeKillResult({ outcome: "respawned", serviceBacked: true }, "x.exe");
  const denied = normalizeKillResult({ outcome: "access-denied" }, "x.exe");
  const tried = { canElevate: true, elevationTried: true };
  assert.strictEqual(killOutcomeView(respawn, tried).view, "respawned");
  assert.strictEqual(killOutcomeView(denied, tried).view, "admin");
  assert.strictEqual(killOutcomeView(denied, { canElevate: true }).view, "elevate");

  assert.match(PAGE_SOURCE, /_elevationTried\.add\(processName\)/);
  assert.match(PAGE_SOURCE, /elevationTried: _elevationTried\.has\(processName\)/);
});

test("kill-all results match rows by exact or sanitised name, never by a collision", () => {
  const lookup = indexKillResults([
    { processName: "Zoom.exe", outcome: "closed" },
    { processName: "a<b.exe", outcome: "closed" },
    { processName: "a>b.exe", outcome: "respawned" },
    { processName: "obs64.exe", outcome: "closed" },
  ]);
  assert.strictEqual(lookup("Zoom.exe").outcome, "closed");
  assert.strictEqual(lookup("a<b.exe").outcome, "closed");
  // "ab.exe" is what both sanitise to, so it must not resolve to either.
  assert.strictEqual(lookup("ab.exe"), undefined);
  assert.strictEqual(lookup("missing.exe"), undefined);
  assert.strictEqual(indexKillResults(null)("Zoom.exe"), undefined);
});
