/**
 * test/preflightVerdict.test.js
 * ─────────────────────────────
 * Regression tests for the preflight verdict contract.
 *
 * These exist because the preflight used to fail OPEN in three separate ways
 * while the live interview tick failed closed. Each "unverified" case below is a
 * bug that shipped: a probe that could not complete rendered a green "Ready"
 * badge and enabled Proceed. The invariant to protect is simple — nothing but an
 * affirmative pass may open the gate.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const {
  PASS,
  FAIL,
  UNVERIFIED,
  CHECK_IDS,
  mapHdmi,
  mapProcesses,
  mapAgent,
  buildVerdicts,
  canProceed,
} = require("../src/detector/preflightVerdict");

// ─── HDMI ────────────────────────────────────────────────────────────────────

test("mapHdmi: a clear probe passes", () => {
  assert.strictEqual(mapHdmi({ detected: false, status: "clear" }).status, PASS);
});

test("mapHdmi: a detected external display fails", () => {
  assert.strictEqual(mapHdmi({ detected: true, status: "violation" }).status, FAIL);
});

test("mapHdmi: indeterminate is unverified, NOT a pass", () => {
  // hdmiDetector returns detected:false alongside indeterminate. Reading only
  // the boolean is what made a thrown display probe render as "no external
  // display detected".
  const v = mapHdmi({ detected: false, status: "indeterminate" });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapHdmi: a missing result is unverified", () => {
  assert.strictEqual(mapHdmi(undefined).status, UNVERIFIED);
  assert.strictEqual(mapHdmi(null).status, UNVERIFIED);
});

// ─── Processes ───────────────────────────────────────────────────────────────

test("mapProcesses: a clean scan passes all four cards", () => {
  const vs = mapProcesses({ detected: false, status: "clear", details: { processes: [] } });
  assert.strictEqual(vs.length, 4);
  assert.ok(vs.every((v) => v.status === PASS));
});

test("mapProcesses: indeterminate marks ALL four cards unverified", () => {
  // The regression: detectMirroring returns an empty process list alongside
  // indeterminate, so every category looked clean and all four went green.
  const vs = mapProcesses({ detected: false, status: "indeterminate", details: { processes: [] } });
  assert.strictEqual(vs.length, 4);
  assert.ok(vs.every((v) => v.status === UNVERIFIED), "no category may pass on an incomplete scan");
});

test("mapProcesses: a missing result marks all four unverified", () => {
  assert.ok(mapProcesses(undefined).every((v) => v.status === UNVERIFIED));
});

test("mapProcesses: a blocked app fails its own card and carries the kill list", () => {
  const vs = mapProcesses({
    detected: true,
    status: "violation",
    details: { processes: ["zoom.exe"] },
  });
  const byId = Object.fromEntries(vs.map((v) => [v.id, v]));
  assert.strictEqual(byId.meeting.status, FAIL);
  assert.deepStrictEqual(byId.meeting.blockedApps, ["zoom.exe"]);
  // Unrelated categories still pass — a failure must not smear across cards.
  assert.strictEqual(byId.ai.status, PASS);
});

test("mapProcesses: an unrecognised blocked app lands on the wireless card", () => {
  const vs = mapProcesses({
    detected: true,
    status: "violation",
    details: { processes: ["some-remote-tool.exe"] },
  });
  const wireless = vs.find((v) => v.id === "wireless");
  assert.strictEqual(wireless.status, FAIL);
  assert.deepStrictEqual(wireless.blockedApps, ["some-remote-tool.exe"]);
});

// ─── Agent ───────────────────────────────────────────────────────────────────

test("mapAgent: a clean scan passes", () => {
  const v = mapAgent({ alive: true, status: { threats: [], safe_to_proceed: true } });
  assert.strictEqual(v.status, PASS);
});

test("mapAgent: a dead agent fails", () => {
  assert.strictEqual(mapAgent({ alive: false, status: null }).status, FAIL);
  assert.strictEqual(mapAgent(null).status, FAIL);
});

test("mapAgent: alive but no scan result is unverified, NOT a clean pass", () => {
  // The regression: threats ?? [] made a missing scan indistinguishable from a
  // scan that found nothing, so the card claimed the device was clean on the
  // strength of a scan that never ran.
  const v = mapAgent({ alive: true, status: null });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapAgent: threats fail and are carried through for rendering", () => {
  const threats = [{ type: "ai_tool", detail: "x", severity: "HIGH" }];
  const v = mapAgent({ alive: true, status: { threats, safe_to_proceed: false } });
  assert.strictEqual(v.status, FAIL);
  assert.deepStrictEqual(v.threats, threats);
  assert.strictEqual(v.reasonParams.n, 1);
});

test("mapAgent: a degraded scan is unverified even with zero threats", () => {
  const v = mapAgent({ alive: true, status: { threats: [], degraded: true, safe_to_proceed: true } });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapAgent: safe_to_proceed=false with no threats is unverified", () => {
  const v = mapAgent({ alive: true, status: { threats: [], safe_to_proceed: false } });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapAgent: an older agent build without the new fields still passes when clean", () => {
  // Backwards compatibility: resources/agent.exe is gitignored and may lag the
  // JS. Absent `degraded`/`safe_to_proceed` must not wedge the gate shut.
  const v = mapAgent({ alive: true, status: { threats: [] } });
  assert.strictEqual(v.status, PASS);
});

// ─── Cross-language contract with agent.py ───────────────────────────────────
// These fixtures are REAL output captured from `agent.py` contract v2 (verified
// by running run_full_scan() directly). agent.py ships as a PyInstaller binary
// that is gitignored and rebuilt separately, so nothing else in this repo checks
// that the two sides still agree — if someone changes the Python result shape,
// these are what catch it.

const AGENT_V2_CLEAN = {
  status: "CLEAR",
  os: "Windows",
  threats: [],
  safe_to_proceed: true,
  scan_count: 1,
  agent_version: "1.0.0",
  physical_monitors: 1,
  contract_version: 2,
  checks: {
    window_titles: "ok", network: "ok", memory_patterns: "ok",
    browser_automation: "ok", window_classes: "ok", ai_tools: "ok",
    overlay_windows: "ok", virtual_audio: "ok", physical_monitors: "ok",
  },
  degraded: false,
};

test("agent contract v2: a clean scan passes", () => {
  assert.strictEqual(mapAgent({ alive: true, status: AGENT_V2_CLEAN }).status, PASS);
});

test("agent contract v2: a degraded scan is unverified, not a pass", () => {
  // Some of the agent's own checks errored, so it cannot vouch for the machine
  // even though it found nothing. safe_to_proceed goes false alongside degraded.
  const degraded = {
    ...AGENT_V2_CLEAN,
    checks: { ...AGENT_V2_CLEAN.checks, window_titles: "error", overlay_windows: "error" },
    degraded: true,
    safe_to_proceed: false,
  };
  assert.strictEqual(mapAgent({ alive: true, status: degraded }).status, UNVERIFIED);
});

test("agent contract v2: an unreadable monitor count does not read as 'no mirror'", () => {
  // count_physical_monitors() returns null (not 0) when it fails, and marks its
  // own check errored -> degraded -> unverified. 0 is legitimate on macOS/Linux.
  const cantCount = {
    ...AGENT_V2_CLEAN,
    physical_monitors: null,
    checks: { ...AGENT_V2_CLEAN.checks, physical_monitors: "error" },
    degraded: true,
    safe_to_proceed: false,
  };
  assert.strictEqual(mapAgent({ alive: true, status: cantCount }).status, UNVERIFIED);
  // And the value itself must never coerce into a "clear" mirror check.
  assert.strictEqual(cantCount.physical_monitors > 1, false);
  assert.strictEqual((cantCount.physical_monitors || 0) > 1, false);
});

test("agent contract v1 (stale agent.exe): still passes when genuinely clean", () => {
  // resources/agent.exe is gitignored and may lag the Python source, so a build
  // predating contract v2 must not wedge the gate shut.
  const v1 = { status: "CLEAR", threats: [], safe_to_proceed: true, physical_monitors: 1 };
  assert.strictEqual(mapAgent({ alive: true, status: v1 }).status, PASS);
});

// ─── Gate ────────────────────────────────────────────────────────────────────

const cleanRaw = {
  hdmi: { detected: false, status: "clear" },
  mirror: { detected: false, status: "clear", details: { processes: [] } },
  agent: { alive: true, status: { threats: [], safe_to_proceed: true } },
};

test("buildVerdicts: returns one verdict per check, in display order", () => {
  const vs = buildVerdicts(cleanRaw);
  assert.deepStrictEqual(vs.map((v) => v.id), CHECK_IDS);
});

test("canProceed: true only when every check passed", () => {
  assert.strictEqual(canProceed(buildVerdicts(cleanRaw)), true);
});

test("canProceed: a single unverified check closes the gate", () => {
  for (const id of CHECK_IDS) {
    const vs = buildVerdicts(cleanRaw).map((v) =>
      v.id === id ? { ...v, status: UNVERIFIED } : v
    );
    assert.strictEqual(canProceed(vs), false, `${id} unverified must block Proceed`);
  }
});

test("canProceed: a single failed check closes the gate", () => {
  for (const id of CHECK_IDS) {
    const vs = buildVerdicts(cleanRaw).map((v) => (v.id === id ? { ...v, status: FAIL } : v));
    assert.strictEqual(canProceed(vs), false, `${id} failed must block Proceed`);
  }
});

test("canProceed: malformed input never opens the gate", () => {
  assert.strictEqual(canProceed(null), false);
  assert.strictEqual(canProceed([]), false);
  assert.strictEqual(canProceed(undefined), false);
  // A short list must not pass just because everything present happens to pass.
  assert.strictEqual(canProceed([{ id: "hdmi", status: PASS }]), false);
});

test("canProceed: an entirely failed scan is closed", () => {
  const vs = buildVerdicts({ hdmi: null, mirror: null, agent: null });
  assert.strictEqual(canProceed(vs), false);
  assert.strictEqual(vs.length, CHECK_IDS.length);
});
