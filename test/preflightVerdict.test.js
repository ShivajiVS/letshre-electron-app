// Regression tests for the preflight verdict contract. The preflight used to
// fail OPEN in several ways: a probe that couldn't complete rendered a green
// "Ready" badge and enabled Proceed. Each "unverified" case below is one of
// those shipped bugs — nothing but an affirmative pass may open the gate.

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

test("mapHdmi: a clear probe passes", () => {
  assert.strictEqual(mapHdmi({ detected: false, status: "clear" }).status, PASS);
});

test("mapHdmi: a detected external display fails", () => {
  assert.strictEqual(mapHdmi({ detected: true, status: "violation" }).status, FAIL);
});

test("mapHdmi: indeterminate is unverified, NOT a pass", () => {
  // hdmiDetector returns detected:false alongside indeterminate — reading only
  // the boolean made a thrown display probe render as "no external display".
  const v = mapHdmi({ detected: false, status: "indeterminate" });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapHdmi: a missing result is unverified", () => {
  assert.strictEqual(mapHdmi(undefined).status, UNVERIFIED);
  assert.strictEqual(mapHdmi(null).status, UNVERIFIED);
});

test("mapProcesses: a clean scan passes all four cards", () => {
  const vs = mapProcesses({ detected: false, status: "clear", details: { processes: [] } });
  assert.strictEqual(vs.length, 4);
  assert.ok(vs.every((v) => v.status === PASS));
});

test("mapProcesses: indeterminate marks ALL four cards unverified", () => {
  // Regression: detectMirroring returns an empty process list alongside
  // indeterminate, so every category looked clean and all four went green.
  const vs = mapProcesses({ detected: false, status: "indeterminate", details: { processes: [] } });
  assert.strictEqual(vs.length, 4);
  assert.ok(
    vs.every((v) => v.status === UNVERIFIED),
    "no category may pass on an incomplete scan"
  );
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

test("mapAgent: a clean scan passes", () => {
  const v = mapAgent({
    alive: true,
    status: { threats: [], safe_to_proceed: true, contract_version: 2 },
  });
  assert.strictEqual(v.status, PASS);
});

test("mapAgent: a dead agent fails", () => {
  assert.strictEqual(mapAgent({ alive: false, status: null }).status, FAIL);
  assert.strictEqual(mapAgent(null).status, FAIL);
});

test("mapAgent: alive but no scan result is unverified, NOT a clean pass", () => {
  // Regression: `threats ?? []` made a missing scan indistinguishable from a
  // scan that found nothing, so the card claimed a clean device on the
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
  const v = mapAgent({
    alive: true,
    status: { threats: [], degraded: true, safe_to_proceed: true },
  });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapAgent: safe_to_proceed=false with no threats is unverified", () => {
  const v = mapAgent({ alive: true, status: { threats: [], safe_to_proceed: false } });
  assert.strictEqual(v.status, UNVERIFIED);
});

test("mapAgent: an older agent build without the new fields is unverified, not a pass", () => {
  // resources/agent.exe is gitignored and may lag the JS. This used to be
  // backwards-compat'd as a pass: absent `degraded`/`safe_to_proceed` fell
  // through every check and read as "nothing to flag". But a build old enough
  // to omit those fields is also old enough to omit `contract_version`, which
  // is exactly the stale-agent signal this now fails closed on.
  const v = mapAgent({ alive: true, status: { threats: [] } });
  assert.strictEqual(v.status, UNVERIFIED);
});

// These fixtures are real output captured from `agent.py` contract v2 (via
// run_full_scan()). agent.py ships as a gitignored PyInstaller binary built
// separately, so these tests are what catch it if the Python result shape drifts.

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
    window_titles: "ok",
    network: "ok",
    memory_patterns: "ok",
    browser_automation: "ok",
    window_classes: "ok",
    ai_tools: "ok",
    overlay_windows: "ok",
    virtual_audio: "ok",
    physical_monitors: "ok",
  },
  degraded: false,
};

test("agent contract v2: a clean scan passes", () => {
  assert.strictEqual(mapAgent({ alive: true, status: AGENT_V2_CLEAN }).status, PASS);
});

test("agent contract v2: a degraded scan is unverified, not a pass", () => {
  // Some of the agent's own checks errored, so it can't vouch for the machine
  // even though it found nothing; safe_to_proceed goes false alongside degraded.
  const degraded = {
    ...AGENT_V2_CLEAN,
    checks: { ...AGENT_V2_CLEAN.checks, window_titles: "error", overlay_windows: "error" },
    degraded: true,
    safe_to_proceed: false,
  };
  assert.strictEqual(mapAgent({ alive: true, status: degraded }).status, UNVERIFIED);
});

test("agent contract v2: an unreadable monitor count does not read as 'no mirror'", () => {
  // count_physical_monitors() returns null (not 0) on failure and marks its own
  // check errored -> degraded -> unverified; 0 is legitimate on macOS/Linux.
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

test("agent contract v1 (stale agent.exe): unverified even when it self-reports clean", () => {
  // resources/agent.exe is gitignored and may lag the Python source. v1 has no
  // `contract_version` key at all (added in v2) and no `degraded` concept, so
  // its safe_to_proceed:true can't account for a check that silently errored —
  // MINIMUM_SUPPORTED_CONTRACT_VERSION rejects it instead of trusting it.
  const v1 = { status: "CLEAR", threats: [], safe_to_proceed: true, physical_monitors: 1 };
  assert.strictEqual(mapAgent({ alive: true, status: v1 }).status, UNVERIFIED);
});

test("agent contract version: below MINIMUM_SUPPORTED_CONTRACT_VERSION is unverified", () => {
  const belowMin = { ...AGENT_V2_CLEAN, contract_version: 1 };
  assert.strictEqual(mapAgent({ alive: true, status: belowMin }).status, UNVERIFIED);
});

test("agent contract version: missing contract_version is unverified", () => {
  const noVersion = { ...AGENT_V2_CLEAN };
  delete noVersion.contract_version;
  assert.strictEqual(mapAgent({ alive: true, status: noVersion }).status, UNVERIFIED);
});

test("agent contract version: at or above the minimum behaves exactly as today", () => {
  assert.strictEqual(mapAgent({ alive: true, status: AGENT_V2_CLEAN }).status, PASS);
  const future = { ...AGENT_V2_CLEAN, contract_version: 3 };
  assert.strictEqual(mapAgent({ alive: true, status: future }).status, PASS);
});

const cleanRaw = {
  hdmi: { detected: false, status: "clear" },
  mirror: { detected: false, status: "clear", details: { processes: [] } },
  agent: {
    alive: true,
    status: { threats: [], safe_to_proceed: true, contract_version: 2 },
  },
};

test("buildVerdicts: returns one verdict per check, in display order", () => {
  const vs = buildVerdicts(cleanRaw);
  assert.deepStrictEqual(
    vs.map((v) => v.id),
    CHECK_IDS
  );
});

test("canProceed: true only when every check passed", () => {
  assert.strictEqual(canProceed(buildVerdicts(cleanRaw)), true);
});

test("canProceed: a single unverified check closes the gate", () => {
  for (const id of CHECK_IDS) {
    const vs = buildVerdicts(cleanRaw).map((v) => (v.id === id ? { ...v, status: UNVERIFIED } : v));
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
