"use strict";

const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { CLEAN_AGENT } = require("./_preflightHarness");
const { getLists } = require("../src/shared/blocklist");
const {
  IPC,
  GUARD_INTERVAL_MS,
  GUARD_CLEAR_TICKS,
  GUARD_UNVERIFIED_TICKS,
  GUARD_DOOR_CHECK_DEADLINE_MS,
} = require("../src/shared/constants");

const FLOW_GUARD = require.resolve("../src/main/flowGuard");
const STUBBED = {
  hdmi: require.resolve("../src/detector/hdmiDetector"),
  mirror: require.resolve("../src/detector/mirrorDetector"),
  agentClient: require.resolve("../src/detector/agentClient"),
  agentManager: require.resolve("../src/main/agentManager"),
  systemChecks: require.resolve("../src/detector/systemChecks"),
  logger: require.resolve("../src/main/logger"),
  electron: require.resolve("electron"),
};

const CLEAN = { found: [], status: "clear" };
const ZOOM = { found: ["zoom.exe"], status: "clear" };
const ONE_DISPLAY = { detected: false, status: "clear", count: 1, monitors: [] };

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function load() {
  const fake = {
    hdmi: async () => ONE_DISPLAY,
    processes: async () => CLEAN,
    status: async () => CLEAN_AGENT(),
    agentReady: async () => true,
    probes: 0,
    readyCalls: 0,
    restarts: 0,
    audit: [],
    remembered: [],
  };
  const screen = new EventEmitter();

  stub(STUBBED.hdmi, { detectHDMIWindows: () => fake.hdmi() });
  const mirror = async () => ({});
  mirror.checkProcesses = () => {
    fake.probes += 1;
    return fake.processes();
  };
  mirror.invalidateProcessCache = () => {};
  stub(STUBBED.mirror, mirror);
  stub(STUBBED.agentClient, { fetchAgentStatus: () => fake.status() });
  stub(STUBBED.agentManager, {
    whenAgentReady: () => {
      fake.readyCalls += 1;
      return fake.agentReady();
    },
    restartAgent: async () => {
      fake.restarts += 1;
      return true;
    },
  });
  stub(STUBBED.systemChecks, {
    recordAuditEvent: (type, data) => fake.audit.push({ type, data }),
    rememberThreats: (threats) => fake.remembered.push(threats),
  });
  const noop = () => {};
  stub(STUBBED.logger, { info: noop, warn: noop, error: noop, debug: noop });
  stub(STUBBED.electron, { screen });

  delete require.cache[FLOW_GUARD];
  return { guard: require(FLOW_GUARD), fake, screen };
}

function fakeWin({ focused = true } = {}) {
  const win = new EventEmitter();
  Object.assign(win, {
    sent: [],
    flashes: [],
    focused,
    destroyed: false,
    url: "file:///C:/app/assets/permissions.html",
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused,
    flashFrame: (on) => win.flashes.push(on),
  });
  win.webContents = new EventEmitter();
  win.webContents.getURL = () => win.url;
  win.webContents.send = (channel, payload) => win.sent.push({ channel, payload });
  return win;
}

let h;
afterEach(() => {
  h?.guard.stop();
  h = null;
  mock.timers.reset();
  delete require.cache[FLOW_GUARD];
  for (const id of Object.values(STUBBED)) {
    delete require.cache[id];
  }
});

async function started(stage = "permissions", winOpts) {
  h?.guard.stop();
  h = load();
  const win = fakeWin(winOpts);
  h.guard.start(win, stage);
  await h.guard._internal.settle();
  return win;
}

const tick = () => h.guard._internal.tick();
const state = () => h.guard.getState();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const pushes = (win) =>
  win.sent.filter((m) => m.channel === IPC.PUSH_GUARD_STATUS).map((m) => m.payload);

async function blocked() {
  const win = await started();
  h.fake.processes = async () => ZOOM;
  await tick();
  h.fake.processes = async () => CLEAN;
  return win;
}

// ─── State machine

test("a clean start is clear on its stage", async () => {
  await started();
  assert.deepStrictEqual(
    { ...state(), seq: undefined },
    { status: "clear", stage: "permissions", seq: undefined, checking: false, issues: [] }
  );
  assert.strictEqual(h.guard.isClear(), true);
  assert.strictEqual(h.guard.getStage(), "permissions");
});

test("the first dirty tick blocks", async () => {
  await started();
  h.fake.processes = async () => ZOOM;
  await tick();
  assert.strictEqual(state().status, "blocked");
  assert.deepStrictEqual(state().issues, [
    {
      category: "meeting",
      code: "blocked_app",
      apps: [{ process: "zoom.exe", name: "Zoom" }],
      closable: true,
    },
  ]);
  assert.strictEqual(h.guard.isClear(), false);
});

test("a block clears only after enough clean ticks in a row", async () => {
  await blocked();
  const issues = state().issues;

  for (let i = 1; i < GUARD_CLEAR_TICKS; i++) {
    await tick();
    assert.strictEqual(state().status, "blocked");
    assert.deepStrictEqual(state().issues, issues, "the last violation stays on screen");
  }
  h.fake.processes = async () => ({ found: [], status: "indeterminate" });
  await tick();
  h.fake.processes = async () => CLEAN;
  for (let i = 1; i < GUARD_CLEAR_TICKS; i++) {
    await tick();
    assert.strictEqual(state().status, "blocked", "a tick that couldn't answer resets the count");
  }
  await tick();
  assert.strictEqual(state().status, "clear");
  assert.deepStrictEqual(state().issues, []);
});

test("checks that can't answer make it unverified after enough ticks in a row", async () => {
  await started();
  h.fake.status = async () => null;
  for (let i = 1; i < GUARD_UNVERIFIED_TICKS; i++) {
    await tick();
    assert.strictEqual(state().status, "clear");
  }
  await tick();
  assert.strictEqual(state().status, "unverified");
  assert.deepStrictEqual(state().issues, [
    { category: "agent", code: "agent_unreachable", apps: [], closable: false },
  ]);

  h.fake.status = async () => CLEAN_AGENT();
  for (let i = 0; i < GUARD_CLEAR_TICKS; i++) {
    await tick();
  }
  assert.strictEqual(state().status, "clear");
});

test("a dirty tick outranks checks that couldn't answer", async () => {
  await started();
  h.fake.status = async () => null;
  h.fake.processes = async () => ZOOM;
  await tick();
  assert.strictEqual(state().status, "blocked");
  assert.deepStrictEqual(
    state().issues.map((i) => i.code),
    ["blocked_app"]
  );
});

test("a block that stops answering stays blocked until the unverified threshold", () => {
  h = load();
  const { nextState, initialMachine } = h.guard._internal;
  const zoom = { category: "meeting", code: "blocked_app", apps: [], closable: true };
  const lost = { category: "agent", code: "agent_unreachable", apps: [], closable: false };

  let m = nextState(initialMachine(), { dirty: [zoom], unanswered: [lost] });
  assert.strictEqual(m.status, "blocked");
  assert.strictEqual(m.unansweredStreak, 1);
  for (let i = 2; i < GUARD_UNVERIFIED_TICKS; i++) {
    m = nextState(m, { dirty: [], unanswered: [lost] });
    assert.strictEqual(m.status, "blocked");
    assert.deepStrictEqual(m.issues, [zoom]);
  }
  m = nextState(m, { dirty: [], unanswered: [lost] });
  assert.strictEqual(m.status, "unverified");
  assert.deepStrictEqual(m.issues, [lost]);
});

// ─── Issue mapping

test("a verified single display plus extra physical panels is a mirrored display", () => {
  h = load();
  const { classifyTick } = h.guard._internal;
  const agent = { ...CLEAN_AGENT(), physical_monitors: 2 };

  const mirrored = classifyTick({ proc: CLEAN, hdmi: ONE_DISPLAY, agent });
  assert.deepStrictEqual(mirrored.dirty, [
    { category: "hdmi", code: "mirrored_display", apps: [], closable: false, count: 2 },
  ]);

  const unknown = classifyTick({ proc: CLEAN, hdmi: { status: "indeterminate" }, agent });
  assert.deepStrictEqual(unknown.dirty, []);
  assert.deepStrictEqual(unknown.unanswered, [
    { category: "hdmi", code: "check_unverified", apps: [], closable: false },
  ]);

  const external = classifyTick({
    proc: CLEAN,
    hdmi: { detected: true, status: "violation", count: 3 },
    agent: CLEAN_AGENT(),
  });
  assert.deepStrictEqual(external.dirty, [
    { category: "hdmi", code: "external_display", apps: [], closable: false, count: 3 },
  ]);
});

test("each failing process card is its own closable issue", () => {
  h = load();
  const ai = getLists().ai[0];
  const { dirty, unanswered } = h.guard._internal.classifyTick({
    proc: { found: ["zoom.exe", "obs64.exe", "chrome.exe", ai], status: "clear" },
    hdmi: ONE_DISPLAY,
    agent: CLEAN_AGENT(),
  });
  assert.deepStrictEqual(unanswered, []);
  assert.deepStrictEqual(
    dirty.map((i) => [i.category, i.code, i.apps.map((a) => a.process), i.closable]),
    [
      ["meeting", "blocked_app", ["zoom.exe"], true],
      ["screen", "blocked_app", ["obs64.exe"], true],
      ["browser", "blocked_app", ["chrome.exe"], true],
      ["ai", "ai_tool", [ai], true],
    ]
  );
});

test("a failed process scan can't answer for any process card", () => {
  h = load();
  const { dirty, unanswered } = h.guard._internal.classifyTick({
    proc: { found: [], status: "indeterminate" },
    hdmi: ONE_DISPLAY,
    agent: CLEAN_AGENT(),
  });
  assert.deepStrictEqual(dirty, []);
  assert.deepStrictEqual(
    unanswered.map((i) => [i.category, i.code]),
    ["meeting", "screen", "wireless", "browser", "ai"].map((c) => [c, "check_unverified"])
  );
});

test("agent threats are grouped by code, closable only when every one has a PID and name", () => {
  h = load();
  const threats = [
    { type: "ai_cheating_tool", process: "Parakeet.exe", pid: 10 },
    { type: "ai_cheating_tool", process: "Parakeet.exe", pid: 10 },
    { type: "ai_cheating_tool", process: "other.exe", pid: 11 },
    { type: "remote_session", detail: "RDP session" },
    { type: "suspicious_network", process: "x.exe", pid: 5 },
    { type: "browser_automation", process: "y.exe" },
  ];
  const result = h.guard._internal.classifyTick({
    proc: CLEAN,
    hdmi: ONE_DISPLAY,
    agent: { ...CLEAN_AGENT(), safe_to_proceed: false, threats },
  });
  assert.deepStrictEqual(result.dirty, [
    {
      category: "agent",
      code: "ai_tool",
      apps: [
        { process: "Parakeet.exe", name: "Parakeet AI", pid: 10 },
        { process: "other.exe", name: "other.exe", pid: 11 },
      ],
      closable: true,
    },
    { category: "agent", code: "remote_session", apps: [], closable: false },
    {
      category: "agent",
      code: "suspicious_activity",
      apps: [
        { process: "x.exe", name: "x.exe", pid: 5 },
        { process: "y.exe", name: "y.exe" },
      ],
      closable: false,
    },
  ]);
  assert.strictEqual(result.threats, threats);
});

test("an agent that can't vouch is unverified; one that doesn't answer is unreachable", () => {
  h = load();
  const { classifyTick } = h.guard._internal;
  const agentIssue = (agent) =>
    classifyTick({ proc: CLEAN, hdmi: ONE_DISPLAY, agent }).unanswered.map((i) => [
      i.category,
      i.code,
    ]);
  assert.deepStrictEqual(agentIssue({ ...CLEAN_AGENT(), degraded: true }), [
    ["agent", "check_unverified"],
  ]);
  assert.deepStrictEqual(agentIssue(null), [["agent", "agent_unreachable"]]);
  assert.deepStrictEqual(agentIssue({ error: "boom" }), [["agent", "agent_unreachable"]]);
  assert.deepStrictEqual(agentIssue(CLEAN_AGENT()), []);
});

test("threats seen by a tick are remembered so their PIDs can be closed", async () => {
  await started();
  const threats = [{ type: "ai_cheating_tool", process: "x.exe", pid: 7 }];
  h.fake.status = async () => ({ ...CLEAN_AGENT(), safe_to_proceed: false, threats });
  await tick();
  assert.deepStrictEqual(h.fake.remembered.at(-1), threats);
});

// ─── Ticks, pushes and lifecycle

test("a tick that outlives a stop/start is dropped", async () => {
  const win = await started();
  let release;
  h.fake.processes = () => new Promise((resolve) => (release = () => resolve(ZOOM)));
  const stale = tick();
  await flush();
  h.guard.stop();
  h.fake.processes = async () => CLEAN;
  h.guard.start(win, "permissions");
  await h.guard._internal.settle();
  release();
  await stale;
  assert.strictEqual(state().status, "clear");
});

test("a tick that finishes after a newer one is dropped", async () => {
  await started();
  let release;
  h.fake.processes = () => new Promise((resolve) => (release = () => resolve(ZOOM)));
  const older = tick();
  await flush();
  h.fake.processes = async () => CLEAN;
  await tick();
  release();
  await older;
  assert.strictEqual(state().status, "clear");
});

test("seq moves only when the pushed state changes", async () => {
  const win = await started();
  const seq = state().seq;
  await tick();
  await tick();
  assert.strictEqual(state().seq, seq);

  h.fake.processes = async () => ZOOM;
  await tick();
  await tick();
  assert.strictEqual(state().seq, seq + 1);

  const seqs = pushes(win).map((p) => p.seq);
  assert.deepStrictEqual(
    seqs,
    [...seqs].sort((a, b) => a - b)
  );
  assert.strictEqual(new Set(seqs).size, seqs.length);
  assert.deepStrictEqual(pushes(win).at(-1), state());
});

test("pushes reach local pages only, and every local page load gets the state again", async () => {
  const win = await started();
  const before = pushes(win).length;
  win.webContents.emit("did-finish-load");
  assert.strictEqual(pushes(win).length, before + 1);
  assert.deepStrictEqual(pushes(win).at(-1), state());

  win.url = "https://interview.letshyre.com/session";
  h.fake.processes = async () => ZOOM;
  await tick();
  win.webContents.emit("did-finish-load");
  assert.strictEqual(pushes(win).length, before + 1);
});

test("display changes tick at once while running", async () => {
  await started();
  assert.strictEqual(h.screen.listenerCount("display-added"), 1);
  assert.strictEqual(h.screen.listenerCount("display-removed"), 1);
  h.fake.hdmi = async () => ({ detected: true, status: "violation", count: 2 });
  h.screen.emit("display-added");
  await flush();
  assert.deepStrictEqual(state().issues, [
    { category: "hdmi", code: "external_display", apps: [], closable: false, count: 2 },
  ]);
});

test("stop() clears the interval and every listener, and is safe twice", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const win = await started();
  const afterStart = h.fake.probes;
  mock.timers.tick(GUARD_INTERVAL_MS);
  await h.guard._internal.settle();
  assert.strictEqual(h.fake.probes, afterStart + 1, "the interval ticks while running");

  h.fake.processes = async () => ZOOM;
  win.focused = false;
  await tick();
  h.guard.stop();
  h.guard.stop();

  mock.timers.tick(GUARD_INTERVAL_MS * 3);
  await flush();
  assert.strictEqual(h.fake.probes, afterStart + 2);
  assert.strictEqual(h.screen.listenerCount("display-added"), 0);
  assert.strictEqual(h.screen.listenerCount("display-removed"), 0);
  assert.strictEqual(win.webContents.listenerCount("did-finish-load"), 0);
  assert.strictEqual(win.listenerCount("closed"), 0);
  assert.strictEqual(win.listenerCount("focus"), 0);
  assert.strictEqual(win.flashes.at(-1), false, "a flashing taskbar button is stopped");
  assert.strictEqual(h.guard.isRunning(), false);
  assert.strictEqual(h.guard.getStage(), null);
  assert.strictEqual(state().status, "clear");
});

test("a destroyed or closed window stops the guard", async () => {
  const win = await started();
  win.destroyed = true;
  h.fake.processes = async () => ZOOM;
  await tick();
  assert.strictEqual(h.guard.isRunning(), false);

  const other = fakeWin();
  h.guard.start(other, "identity");
  await h.guard._internal.settle();
  other.emit("closed");
  assert.strictEqual(h.guard.isRunning(), false);
});

test("a block while the window is in the background flashes the taskbar until focus", async () => {
  const win = await started("permissions", { focused: false });
  h.fake.processes = async () => ZOOM;
  await tick();
  assert.deepStrictEqual(win.flashes, [true]);
  win.emit("focus");
  assert.deepStrictEqual(win.flashes, [true, false]);

  const focused = await started();
  h.fake.processes = async () => ZOOM;
  await tick();
  assert.deepStrictEqual(focused.flashes, []);
});

test("every transition is audited with its stage, and a cleared block with its length", async () => {
  await started("identity");
  h.fake.processes = async () => ZOOM;
  await tick();
  h.fake.processes = async () => CLEAN;
  for (let i = 0; i < GUARD_CLEAR_TICKS; i++) {
    await tick();
  }
  const events = h.fake.audit.filter((e) => e.type === "guard").map((e) => e.data);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events[0], {
    stage: "identity",
    status: "blocked",
    codes: ["blocked_app"],
  });
  assert.strictEqual(events[1].status, "clear");
  assert.deepStrictEqual(events[1].codes, []);
  assert.ok(Number.isInteger(events[1].durationMs) && events[1].durationMs >= 0);
});

test("setStage moves a running guard and is ignored when stopped", async () => {
  const win = await started();
  h.guard.setStage("identity");
  assert.strictEqual(state().stage, "identity");
  assert.strictEqual(pushes(win).at(-1).stage, "identity");
  h.guard.setStage("interview");
  assert.strictEqual(state().stage, "identity");
  h.guard.stop();
  h.guard.setStage("role");
  assert.strictEqual(h.guard.getStage(), null);
});

// ─── Door check

test("a door check blocks at once on a violation and shows it is checking", async () => {
  const win = await started();
  h.fake.processes = async () => ZOOM;
  const pending = h.guard.checkNow();
  assert.strictEqual(state().checking, true);
  const result = await pending;
  assert.strictEqual(result.status, "blocked");
  assert.strictEqual(result.checking, false);
  assert.deepStrictEqual(result, state());
  assert.ok(pushes(win).some((p) => p.checking === true));
});

test("a door check that can't answer is unverified at once", async () => {
  await started();
  h.fake.status = async () => null;
  const result = await h.guard.checkNow();
  assert.strictEqual(result.status, "unverified");
  assert.deepStrictEqual(
    result.issues.map((i) => i.code),
    ["agent_unreachable"]
  );
});

test("a clean door check counts as one clean tick", async () => {
  await blocked();
  for (let i = 1; i < GUARD_CLEAR_TICKS; i++) {
    assert.strictEqual((await h.guard.checkNow()).status, "blocked");
  }
  assert.strictEqual((await h.guard.checkNow()).status, "clear");
});

test("callers during a door check share it, and seq moves for checking on and off", async () => {
  await started();
  const seq = state().seq;
  const probes = h.fake.probes;
  const first = h.guard.checkNow();
  const second = h.guard.checkNow();
  assert.strictEqual(first, second);
  await first;
  assert.strictEqual(h.fake.probes, probes + 1);
  assert.strictEqual(state().seq, seq + 2);
});

test("a hung probe can't hold the door check past its deadline", async () => {
  await started();
  mock.timers.enable({ apis: ["setTimeout"] });
  h.fake.processes = () => new Promise(() => {});
  const pending = h.guard.checkNow();
  await flush();
  mock.timers.tick(GUARD_DOOR_CHECK_DEADLINE_MS);
  const result = await pending;
  assert.strictEqual(result.status, "unverified");
  assert.ok(result.issues.every((i) => i.code === "check_unverified"));
});

test("a stopped guard's door check answers without probing", async () => {
  h = load();
  const result = await h.guard.checkNow();
  assert.strictEqual(result.stage, null);
  assert.strictEqual(h.fake.probes, 0);
});

test("an agent that stays unreachable is brought back, each attempt further apart", async () => {
  await started();
  h.fake.status = async () => null;
  h.fake.agentReady = async () => false;
  for (let i = 0; i < GUARD_UNVERIFIED_TICKS; i++) {
    await tick();
  }
  await flush();
  assert.strictEqual(h.fake.readyCalls, 1, "the first attempt waits for the agent");

  await h.guard.checkNow();
  await flush();
  assert.strictEqual(h.fake.readyCalls, 1);
  assert.strictEqual(h.fake.restarts, 0, "no new attempt inside the backoff");

  mock.timers.enable({ apis: ["Date"], now: Date.now() + 60000 });
  await h.guard.checkNow();
  await flush();
  assert.strictEqual(h.fake.restarts, 1, "the next attempt restarts it");

  h.fake.status = async () => CLEAN_AGENT();
  await tick();
  h.fake.status = async () => null;
  for (let i = 0; i < GUARD_UNVERIFIED_TICKS; i++) {
    await tick();
  }
  await flush();
  assert.strictEqual(h.fake.readyCalls, 2, "an agent that answered resets the backoff");
});

test("no agent recovery when it's another check that can't answer", async () => {
  await started();
  h.fake.processes = async () => ({ found: [], status: "indeterminate" });
  for (let i = 0; i < GUARD_UNVERIFIED_TICKS + 1; i++) {
    await tick();
  }
  await h.guard.checkNow();
  await flush();
  assert.strictEqual(h.fake.readyCalls, 0);
  assert.strictEqual(h.fake.restarts, 0);
});

// ─── Practice run

test("its stages are the setup steps after the security check, in flow order", () => {
  h = load();
  const { GUARDED_STEP_IDS, STEP_IDS } = require("../src/shared/flowSteps");
  assert.deepStrictEqual(h.guard.STAGES, GUARDED_STEP_IDS);
  assert.deepStrictEqual(h.guard.STAGES, STEP_IDS.slice(STEP_IDS.indexOf("preflight") + 1));
});

test("a practice run stops the guard and keeps it from starting on any stage", async () => {
  const win = await started();
  h.guard.enterPractice();
  assert.strictEqual(h.guard.isPractice(), true);
  assert.strictEqual(h.guard.isRunning(), false);
  for (const stage of h.guard.STAGES) {
    h.guard.start(win, stage);
    assert.strictEqual(h.guard.getStage(), null, stage);
  }
  h.guard.setStage("role");
  assert.strictEqual(h.guard.getStage(), null);
  assert.strictEqual(h.guard.isClear(), false);
});

test("a practice run survives stop() and ends only when left", async () => {
  h = load();
  h.guard.enterPractice();
  h.guard.stop();
  assert.strictEqual(h.guard.isPractice(), true);
  h.guard.leavePractice();
  assert.strictEqual(h.guard.isPractice(), false);
  h.guard.start(fakeWin(), "permissions");
  await h.guard._internal.settle();
  assert.strictEqual(h.guard.getStage(), "permissions");
});
