"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PM = require("../src/renderer/preflightModel");

test("check ids match the contract, in display order", () => {
  assert.deepStrictEqual(
    [...PM.CHECK_IDS],
    ["hdmi", "meeting", "screen", "wireless", "browser", "ai", "agent"]
  );
  assert.ok(!PM.LIVE_CHECK_IDS.includes("agent"));
});

test("scan tokens are valid and unique", () => {
  const a = PM.newScanToken();
  const b = PM.newScanToken();
  assert.ok(PM.isValidToken(a), a);
  assert.notStrictEqual(a, b);
  // Without crypto.randomUUID the fallback still satisfies main's validator.
  const fallback = PM.newScanToken({});
  assert.ok(PM.isValidToken(fallback), fallback);

  assert.ok(!PM.isValidToken(""));
  assert.ok(!PM.isValidToken("a".repeat(65)));
  assert.ok(!PM.isValidToken("abc def"));
  assert.ok(!PM.isValidToken(null));
});

test("only payloads carrying the current scan's token are accepted", () => {
  const token = PM.newScanToken();
  assert.ok(PM.belongsToScan({ token, id: "hdmi" }, token));
  assert.ok(!PM.belongsToScan({ token: "other", id: "hdmi" }, token));
  assert.ok(!PM.belongsToScan({ id: "hdmi" }, token));
  // Between scans there is no current token, so everything is dropped.
  assert.ok(!PM.belongsToScan({ token: undefined }, null));
  assert.ok(!PM.belongsToScan(null, token));
});

test("unknown statuses fail closed", () => {
  assert.strictEqual(PM.toneOf("pass"), "pass");
  assert.strictEqual(PM.toneOf("unverified"), "unverified");
  assert.strictEqual(PM.toneOf("fail"), "fail");
  assert.strictEqual(PM.toneOf("weird"), "fail");
  assert.strictEqual(PM.toneOf(undefined), "fail");
});

test("sameVerdict compares everything a card renders", () => {
  const v = { id: "meeting", status: "fail", reasonKey: "k", blockedApps: ["Zoom.exe"] };
  assert.ok(PM.sameVerdict(v, { ...v }));
  assert.ok(!PM.sameVerdict(v, { ...v, blockedApps: ["Zoom.exe", "Teams.exe"] }));
  assert.ok(!PM.sameVerdict(v, { ...v, status: "pass" }));
  assert.ok(!PM.sameVerdict(v, { ...v, reasonParams: { count: 2 } }));
  assert.ok(!PM.sameVerdict(v, null));

  const agent = { id: "agent", status: "fail", reasonKey: "k", threats: [{ type: "a" }] };
  assert.ok(PM.sameVerdict(agent, { ...agent, threats: [{ type: "a" }] }));
  assert.ok(!PM.sameVerdict(agent, { ...agent, threats: [{ type: "b" }] }));
});

test("summary counts progress and what needs attention", () => {
  const s = PM.summarize(["pass", "fail", "scanning", "unverified", "pass", "scanning", "pass"]);
  assert.deepStrictEqual(s, {
    total: 7,
    done: 5,
    passed: 3,
    failed: 1,
    unverified: 1,
    attention: 2,
  });
});

test("grid spans leave no holes and keep failing cards full width", () => {
  assert.deepStrictEqual(PM.gridSpans([false, false, false, false]), [false, false, false, false]);
  assert.deepStrictEqual(PM.gridSpans([false, true, false, false]), [true, true, false, false]);
  assert.deepStrictEqual(PM.gridSpans([false, false, true, false]), [false, false, true, true]);
  assert.deepStrictEqual(PM.gridSpans([false, false, false]), [false, false, true]);
  assert.deepStrictEqual(PM.gridSpans([true, true]), [true, true]);
  assert.deepStrictEqual(PM.gridSpans([]), []);
});

test("live status: a clean flag never outranks a failing verdict", () => {
  const clean = PM.readLiveStatus({ clean: true, unverified: false, apps: [], verdicts: [] });
  assert.strictEqual(clean.state, "clean");

  const dirty = PM.readLiveStatus({
    clean: true,
    apps: [],
    verdicts: [{ id: "meeting", status: "fail", blockedApps: ["Zoom.exe"] }],
  });
  assert.strictEqual(dirty.state, "dirty");

  const unverified = PM.readLiveStatus({ clean: false, unverified: true, apps: [], verdicts: [] });
  assert.strictEqual(unverified.state, "unverified");

  assert.strictEqual(PM.readLiveStatus(null).state, "unverified");
  assert.strictEqual(PM.readLiveStatus({}).state, "dirty");
});

test("live status keeps only well-formed live verdicts and string app names", () => {
  const live = PM.readLiveStatus({
    clean: false,
    apps: ["Zoom.exe", 42, ""],
    verdicts: [
      { id: "hdmi", status: "fail", reasonKey: "preflightResults.hdmiDetected" },
      { id: "agent", status: "fail" },
      { id: "nope", status: "pass" },
      { id: "browser" },
      null,
    ],
  });
  assert.deepStrictEqual(live.apps, ["Zoom.exe"]);
  assert.deepStrictEqual(
    live.verdicts.map((v) => v.id),
    ["hdmi"]
  );
  assert.strictEqual(live.displayChanged, true);
});

test("kill outcomes map to the right category and view", () => {
  const view = (raw, opts) => PM.killOutcomeView(PM.normalizeKillResult(raw, "x.exe"), opts);
  assert.deepStrictEqual(view({ outcome: "closed" }), { category: "closed", view: "closed" });
  assert.deepStrictEqual(view({ outcome: "already-gone" }), {
    category: "closed",
    view: "already-gone",
  });
  assert.deepStrictEqual(view({ outcome: "still-running" }), {
    category: "still-running",
    view: "still-running",
  });
  assert.deepStrictEqual(view({ outcome: "access-denied" }), {
    category: "access-denied",
    view: "admin",
  });
  for (const outcome of ["not-blocked", "own-process", "spawn-error", "unsupported"]) {
    assert.deepStrictEqual(view({ outcome }), { category: "failed", view: "failed" });
  }
  assert.deepStrictEqual(view({ success: false }), { category: "failed", view: "failed" });
});

test("kill-all outcome picks the summary and the kind of rescan", () => {
  assert.deepStrictEqual(PM.killAllOutcome(["closed", "closed"]), {
    summary: "all-closed",
    closed: 2,
    total: 2,
    rescan: "plain",
  });
  assert.strictEqual(PM.killAllOutcome(["closed", "respawned"]).summary, "reopened");
  assert.strictEqual(PM.killAllOutcome(["closed", "respawned"]).rescan, "evidence");
  assert.strictEqual(PM.killAllOutcome(["failed", "failed"]).summary, "failed");
  assert.strictEqual(PM.killAllOutcome(["failed", "failed"]).rescan, "none");
  assert.strictEqual(PM.killAllOutcome(["closed", "failed"]).summary, "partial");
  assert.strictEqual(PM.killAllOutcome(["closed", "failed"]).rescan, "plain");
  assert.strictEqual(PM.killAllOutcome(["still-running", "failed"]).rescan, "plain");
  assert.strictEqual(PM.killAllOutcome(["access-denied"]).rescan, "evidence");
});

test("auto-rescan names what a rescan can't fix and respects the cap", () => {
  assert.strictEqual(
    PM.autoRescanDecision({ respawned: ["Zoom"], count: 0, max: 3 }),
    "halt-respawned"
  );
  assert.strictEqual(
    PM.autoRescanDecision({ accessDenied: ["OBS"], count: 0, max: 3 }),
    "halt-admin"
  );
  assert.strictEqual(PM.autoRescanDecision({ count: 3, max: 3 }), "halt-cap");
  assert.strictEqual(PM.autoRescanDecision({ count: 2, max: 3 }), "rescan");
});

test("scan errors retry up to the cap", () => {
  assert.deepStrictEqual(PM.scanErrorDecision(0, 3), { retry: true, attempt: 1 });
  assert.deepStrictEqual(PM.scanErrorDecision(2, 3), { retry: true, attempt: 3 });
  assert.strictEqual(PM.scanErrorDecision(3, 3).retry, false);
});

test("support is offered after repeated unverified scans or the retry cap", () => {
  assert.ok(!PM.shouldOfferSupport({ unverifiedStreak: 1 }));
  assert.ok(PM.shouldOfferSupport({ unverifiedStreak: 2 }));
  assert.ok(PM.shouldOfferSupport({ retryCapHit: true }));
  assert.ok(!PM.shouldOfferSupport());
});

test("focus rescans only when something is wrong and nothing else is going on", () => {
  const idle = {
    problem: true,
    scanning: false,
    killing: false,
    elevating: false,
    dialogOpen: false,
    proceeding: false,
    scheduled: false,
  };
  assert.ok(PM.shouldRescanOnFocus(idle));
  assert.ok(!PM.shouldRescanOnFocus({ ...idle, problem: false }));
  for (const busy of [
    "scanning",
    "killing",
    "elevating",
    "dialogOpen",
    "proceeding",
    "scheduled",
  ]) {
    assert.ok(!PM.shouldRescanOnFocus({ ...idle, [busy]: true }), busy);
  }
});

test("severity maps to a translated label and a two-level tone", () => {
  assert.strictEqual(PM.severityInfo("CRITICAL").tone, "strong");
  assert.strictEqual(PM.severityInfo("high").tone, "strong");
  assert.strictEqual(PM.severityInfo("MEDIUM").tone, "soft");
  assert.strictEqual(PM.severityInfo("LOW").key, "preflightResults.severityLow");
  const unknown = PM.severityInfo("EXTREMELY_BAD_AND_LONG_VALUE");
  assert.strictEqual(unknown.key, null);
  assert.ok(unknown.fallback.length <= 16);
  assert.strictEqual(PM.severityInfo(undefined).fallback, "");
});

test("every threat type has its own title, unknown ones get a generic one", () => {
  const types = [
    "suspicious_window_title",
    "suspicious_network",
    "suspicious_dll",
    "browser_automation",
    "suspicious_window_class",
    "ai_cheating_tool",
    "transparent_overlay",
    "virtual_audio_device",
    "remote_session",
    "virtual_machine",
    "renamed_blocked_app",
  ];
  const keys = types.map((t) => PM.threatTitle(t).key);
  assert.strictEqual(new Set(keys).size, types.length);
  assert.strictEqual(PM.threatTitle("something_new").key, "preflightResults.threatGeneric");
  assert.strictEqual(PM.threatTitle("__proto__").key, "preflightResults.threatGeneric");

  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/locales/en.json"), "utf8")
  ).preflightResults;
  for (const key of [...keys, "preflightResults.threatGeneric"]) {
    assert.ok(en[key.split(".")[1]], `${key} missing from en.json`);
  }
});

test("only threats with nothing to close carry a hint", () => {
  assert.strictEqual(PM.threatTitle("remote_session").key, "preflightResults.threatRemoteSession");
  assert.strictEqual(
    PM.threatTitle("virtual_machine").key,
    "preflightResults.threatVirtualMachine"
  );
  assert.strictEqual(
    PM.threatTitle("renamed_blocked_app").key,
    "preflightResults.threatRenamedApp"
  );
  assert.strictEqual(
    PM.threatHint("remote_session").key,
    "preflightResults.threatRemoteSessionHint"
  );
  assert.strictEqual(
    PM.threatHint("virtual_machine").key,
    "preflightResults.threatVirtualMachineHint"
  );
  assert.strictEqual(PM.threatHint("renamed_blocked_app"), null);
  assert.strictEqual(PM.threatHint("suspicious_network"), null);
  assert.strictEqual(PM.threatHint("toString"), null);

  const en = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../assets/locales/en.json"), "utf8")
  ).preflightResults;
  for (const type of ["remote_session", "virtual_machine"]) {
    const hint = PM.threatHint(type);
    assert.strictEqual(en[hint.key.split(".")[1]], hint.fallback);
  }
});

test("a renamed blocked app with a pid can be closed", () => {
  assert.ok(
    PM.isKillableThreat({
      type: "renamed_blocked_app",
      severity: "HIGH",
      process: "notes.exe",
      pid: 4242,
      original: "zoom.exe",
    })
  );
  assert.ok(!PM.isKillableThreat({ type: "remote_session", severity: "HIGH" }));
});

test("threat process labels drop paths and control characters", () => {
  assert.strictEqual(PM.processLabel("C:\\Users\\alice\\AppData\\cluely.exe"), "cluely.exe");
  assert.strictEqual(PM.processLabel("/home/bob/tool"), "tool");
  assert.strictEqual(PM.processLabel("evil\u0007.exe"), "evil.exe");
  assert.strictEqual(PM.processLabel(42), "");
  assert.strictEqual(PM.processLabel("x".repeat(200)).length, 80);
});

test("only threats with a positive integer pid and a process name are killable", () => {
  assert.ok(PM.isKillableThreat({ pid: 1234, process: "cluely.exe" }));
  assert.ok(!PM.isKillableThreat({ pid: 0, process: "cluely.exe" }));
  assert.ok(!PM.isKillableThreat({ pid: "1234", process: "cluely.exe" }));
  assert.ok(!PM.isKillableThreat({ pid: 1.5, process: "cluely.exe" }));
  assert.ok(!PM.isKillableThreat({ pid: 1234 }));
  assert.ok(!PM.isKillableThreat({ pid: 1234, process: "C:\\dir\\" }));
  assert.ok(!PM.isKillableThreat(null));
});

test("bounce reasons map to their status copy", () => {
  assert.strictEqual(PM.bounceReason("stale").key, "preflightResults.bouncedStale");
  assert.strictEqual(PM.bounceReason("dirty").key, "preflightResults.bouncedDirty");
  assert.strictEqual(PM.bounceReason("scanning").key, "preflightResults.bouncedScanning");
  assert.strictEqual(PM.bounceReason("toString"), null);
  assert.strictEqual(PM.bounceReason(null), null);
  assert.strictEqual(PM.bounceReason("other"), null);
});

test("sanitiseProcessKey strips what main strips", () => {
  assert.strictEqual(PM.sanitiseProcessKey("Zoom.exe"), "Zoom.exe");
  assert.strictEqual(PM.sanitiseProcessKey("<img src=x>.exe"), "img srcx.exe");
  assert.strictEqual(PM.sanitiseProcessKey(null), "");
});
