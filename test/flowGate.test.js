"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert");

const { IPC, INTERVIEW_BASE_URL } = require("../src/shared/constants");

const IPC_HANDLERS = require.resolve("../src/main/ipcHandlers");
const IPC_SCOPE = require.resolve("../src/main/ipcScope");
const STUBBED = [
  "electron",
  "../src/main/updater",
  "../src/main/screenRecorder",
  "../src/main/agentManager",
  "../src/main/windowManager",
  "../src/main/protocolHandler",
  "../src/main/localeManager",
  "../src/main/authManager",
  "../src/main/logger",
  "../src/detector/systemChecks",
  "../src/main/flowGuard",
].map((rel) => require.resolve(rel));

const LOCAL = { senderFrame: { origin: "file://", top: null } };
const INTERVIEW = { senderFrame: { origin: new URL(INTERVIEW_BASE_URL).origin, top: null } };
const PASSED = { ok: true, code: "none", reason: "" };
const INTERVIEW_URL = "https://interview.letshyre.com/session";

function guardState(status, stage, issues = []) {
  return { status, stage, seq: 4, checking: false, issues };
}

function load() {
  const handlers = new Map();
  const calls = [];
  const noop = () => {};
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  const win = { loadFile: record("win.loadFile") };
  const g = {
    calls,
    win,
    pass: PASSED,
    release: Promise.resolve(),
    stage: "permissions",
    active: false,
    unavailable: false,
    profile: { success: false },
    check: async () => guardState("clear", g.stage),
    names: () => calls.map((c) => c[0]),
    call: (channel, ...args) => handlers.get(channel)(LOCAL, ...args),
    callFromInterview: (channel, ...args) => handlers.get(channel)(INTERVIEW, ...args),
  };

  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const [
    electron,
    updater,
    screenRecorder,
    agentManager,
    windowManager,
    protocolHandler,
    localeManager,
    authManager,
    logger,
    systemChecks,
    flowGuard,
  ] = STUBBED;

  stub(electron, {
    app: { getVersion: () => "0.0.0", quit: noop },
    shell: {},
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => handlers.set(channel, fn),
    },
  });
  stub(updater, { onInterviewEnded: noop });
  stub(screenRecorder, { registerRecorderIpc: noop, start: async () => ({ ok: true }) });
  stub(agentManager, { whenAgentReady: async () => true, killAgent: record("killAgent") });
  stub(windowManager, {
    getWindow: () => win,
    loadSecurityCheck: record("loadSecurityCheck"),
    loadPermissionsPage: record("loadPermissionsPage"),
    loadIdentityVerificationPage: record("loadIdentityVerificationPage"),
    loadRoleSelectionPage: record("loadRoleSelectionPage"),
    loadLanguageSelectionPage: record("loadLanguageSelectionPage"),
    loadDashboard: record("loadDashboard"),
    lockdownForInterview: record("lockdownForInterview"),
    getIsInterviewActive: () => g.active,
    isShowingUnavailablePage: () => g.active && g.unavailable,
    endInterview: (reason) => {
      calls.push(["endInterview", reason]);
      g.active = false;
      return g.release;
    },
    clearCandidatePhoto: noop,
    clearInterviewSessionData: async () => {},
  });
  stub(protocolHandler, {
    setInterviewSession: noop,
    resetInterviewSession: noop,
    getCurrentInterviewUrl: () => INTERVIEW_URL,
  });
  stub(localeManager, { getSupportedLocales: () => ["en"] });
  stub(authManager, {
    getTokens: () => ({ accessToken: "tok", refreshToken: "ref" }),
    getCandidateProfile: async () => g.profile,
    logout: async () => ({ success: true }),
  });
  stub(logger, { info: noop, warn: noop, error: noop, debug: noop });
  stub(systemChecks, {
    verifyProceedAllowed: (opts) => {
      calls.push(["verifyProceedAllowed", opts]);
      return g.pass;
    },
    stopPreProceedMonitor: record("stopPreProceedMonitor"),
    startPreProceedMonitor: noop,
    resetState: noop,
    start: record("startDetection"),
    stop: record("detection.stop"),
    setSessionContext: record("setSessionContext"),
    isSessionActive: () => g.active,
    sendViolation: record("sendViolation"),
  });
  stub(flowGuard, {
    start: (_win, stage) => {
      calls.push(["guard.start", stage]);
      g.stage = stage;
    },
    stop: () => {
      calls.push(["guard.stop"]);
      g.stage = null;
    },
    setStage: (stage) => {
      calls.push(["guard.setStage", stage]);
      g.stage = stage;
    },
    getStage: () => g.stage,
    isRunning: () => g.stage !== null,
    getState: () => guardState("clear", g.stage),
    checkNow: () => {
      calls.push(["guard.checkNow"]);
      return g.check();
    },
  });

  delete require.cache[IPC_SCOPE];
  delete require.cache[IPC_HANDLERS];
  require(IPC_HANDLERS).registerIpcHandlers();
  return g;
}

afterEach(() => {
  for (const id of [...STUBBED, IPC_SCOPE, IPC_HANDLERS]) {
    delete require.cache[id];
  }
});

const STEPS = [
  {
    channel: IPC.LOAD_IDENTITY_VERIFICATION,
    from: "permissions",
    to: "identity",
    page: "loadIdentityVerificationPage",
  },
  { channel: IPC.LOAD_ROLE_SELECTION, from: "identity", to: "role", page: "loadRoleSelectionPage" },
];

test("each step goes forward from its previous stage and moves the guard first", async () => {
  for (const { channel, from, to, page } of STEPS) {
    const g = load();
    g.stage = from;
    assert.deepStrictEqual(await g.call(channel), { ok: true });
    assert.strictEqual(g.stage, to);
    const names = g.names();
    assert.ok(names.indexOf("guard.checkNow") < names.indexOf("guard.setStage"));
    assert.ok(names.indexOf("guard.setStage") < names.indexOf(page));
    assert.deepStrictEqual(
      g.calls.find((c) => c[0] === "verifyProceedAllowed"),
      ["verifyProceedAllowed", { requireFresh: false }]
    );
  }
});

test("asking again for the stage it is already at is allowed (a reload)", async () => {
  for (const { channel, to, page } of STEPS) {
    const g = load();
    g.stage = to;
    assert.deepStrictEqual(await g.call(channel), { ok: true });
    assert.ok(g.names().includes(page));
  }
});

test("Back from role selection returns to identity verification", async () => {
  const g = load();
  g.stage = "role";
  assert.deepStrictEqual(await g.call(IPC.LOAD_IDENTITY_VERIFICATION), { ok: true });
  assert.strictEqual(g.stage, "identity");
  assert.ok(g.names().includes("loadIdentityVerificationPage"));
});

test("a step out of order is refused before any check or navigation", async () => {
  const cases = [
    [IPC.LOAD_IDENTITY_VERIFICATION, null],
    [IPC.LOAD_ROLE_SELECTION, "permissions"],
    [IPC.PROCEED_TO_INTERVIEW, "identity"],
    [IPC.PROCEED_TO_INTERVIEW, null],
  ];
  for (const [channel, stage] of cases) {
    const g = load();
    g.stage = stage;
    assert.deepStrictEqual(await g.call(channel, {}), { ok: false, reason: "order" });
    assert.deepStrictEqual(
      g.names().filter((n) => n !== "verifyProceedAllowed"),
      [],
      `${channel} from ${stage}`
    );
  }
});

test("a double click gets busy while the first gate is still running", async () => {
  const g = load();
  let release;
  g.check = () => new Promise((resolve) => (release = resolve));
  const first = g.call(IPC.LOAD_IDENTITY_VERIFICATION);
  assert.deepStrictEqual(await g.call(IPC.LOAD_IDENTITY_VERIFICATION), {
    ok: false,
    reason: "busy",
  });
  release(guardState("clear", "permissions"));
  assert.deepStrictEqual(await first, { ok: true });

  g.check = async () => guardState("clear", g.stage);
  assert.deepStrictEqual(await g.call(IPC.LOAD_IDENTITY_VERIFICATION), { ok: true });
});

test("a missing or failed security-check pass sends the candidate back to it", async () => {
  for (const [channel, stage] of [
    [IPC.LOAD_IDENTITY_VERIFICATION, "permissions"],
    [IPC.LOAD_ROLE_SELECTION, "identity"],
    [IPC.PROCEED_TO_INTERVIEW, "role"],
  ]) {
    const g = load();
    g.stage = stage;
    g.pass = { ok: false, code: "failed", reason: "last preflight did not pass" };
    assert.deepStrictEqual(await g.call(channel, {}), { ok: false, reason: "failed" });
    const names = g.names();
    assert.ok(names.indexOf("guard.stop") < names.indexOf("loadSecurityCheck"), channel);
    assert.ok(!names.includes("guard.checkNow"));
    assert.ok(!names.includes("lockdownForInterview"));
  }
});

test("a guard that isn't clear refuses the step and hands back its state", async () => {
  const issues = [
    {
      category: "meeting",
      code: "blocked_app",
      apps: [{ process: "zoom.exe", name: "Zoom" }],
      closable: true,
    },
  ];
  for (const status of ["blocked", "unverified"]) {
    for (const [channel, stage, page] of [
      [IPC.LOAD_IDENTITY_VERIFICATION, "permissions", "loadIdentityVerificationPage"],
      [IPC.LOAD_ROLE_SELECTION, "identity", "loadRoleSelectionPage"],
      [IPC.PROCEED_TO_INTERVIEW, "role", "lockdownForInterview"],
    ]) {
      const g = load();
      g.stage = stage;
      const guard = guardState(status, stage, issues);
      g.check = async () => guard;
      assert.deepStrictEqual(await g.call(channel, {}), { ok: false, reason: status, guard });
      assert.strictEqual(g.stage, stage);
      assert.ok(!g.names().includes(page));
      assert.ok(!g.names().includes("guard.stop"));
      assert.ok(!g.names().includes("startDetection"));
    }
  }
});

test("going back while the check runs refuses the step", async () => {
  const g = load();
  g.stage = "identity";
  g.check = async () => {
    g.stage = "permissions";
    return guardState("clear", "permissions");
  };
  assert.deepStrictEqual(await g.call(IPC.LOAD_ROLE_SELECTION), { ok: false, reason: "order" });
  assert.ok(!g.names().includes("loadRoleSelectionPage"));
  assert.strictEqual(g.stage, "permissions");
});

test("Start Interview stops the guard, then locks down, then starts detection", async () => {
  const g = load();
  g.stage = "role";
  const result = await g.call(IPC.PROCEED_TO_INTERVIEW, {
    is_custom_role: true,
    selected_role: ["  Backend Engineer  ", 42],
    extra: "dropped",
  });
  assert.deepStrictEqual(result, { ok: true });

  const names = g.names();
  const at = (name) => names.indexOf(name);
  assert.ok(at("guard.checkNow") < at("guard.stop"));
  assert.ok(at("guard.stop") < at("lockdownForInterview"));
  assert.ok(at("lockdownForInterview") < at("startDetection"));
  assert.deepStrictEqual(
    g.calls.find((c) => c[0] === "lockdownForInterview"),
    [
      "lockdownForInterview",
      INTERVIEW_URL,
      { accessToken: "tok", refreshToken: "ref" },
      { is_custom_role: true, selected_role: ["Backend Engineer"] },
    ]
  );
  assert.deepStrictEqual(
    g.calls.find((c) => c[0] === "startDetection"),
    ["startDetection", g.win]
  );
  assert.strictEqual(g.stage, null);
});

test("leaving the security check starts the guard on permissions before its page loads", async () => {
  const g = load();
  g.stage = null;
  assert.deepStrictEqual(await g.call(IPC.LOAD_PERMISSIONS_PAGE), { ok: true });
  const names = g.names();
  assert.ok(names.indexOf("stopPreProceedMonitor") < names.indexOf("guard.start"));
  assert.ok(names.indexOf("guard.start") < names.indexOf("loadPermissionsPage"));
  assert.strictEqual(g.stage, "permissions");
});

test("back to permissions moves a running guard, starts a stopped one, and keeps its gate", () => {
  let g = load();
  g.stage = "identity";
  g.call(IPC.BACK_TO_PERMISSIONS);
  assert.deepStrictEqual(
    g.calls.filter((c) => c[0].startsWith("guard.") || c[0] === "loadPermissionsPage"),
    [["guard.setStage", "permissions"], ["loadPermissionsPage"]]
  );

  g = load();
  g.stage = null;
  g.call(IPC.BACK_TO_PERMISSIONS);
  assert.deepStrictEqual(
    g.calls.filter((c) => c[0].startsWith("guard.") || c[0] === "loadPermissionsPage"),
    [["guard.start", "permissions"], ["loadPermissionsPage"]]
  );

  g = load();
  g.stage = "identity";
  g.pass = { ok: false, code: "failed", reason: "no preflight has been run" };
  g.call(IPC.BACK_TO_PERMISSIONS);
  assert.ok(g.names().includes("loadSecurityCheck"));
  assert.ok(!g.names().includes("loadPermissionsPage"));
  assert.strictEqual(g.stage, null);
});

test("every way out of the flow stops the guard", async () => {
  const exits = [
    [IPC.LOAD_DASHBOARD, "local"],
    [IPC.VIEW_DASHBOARD, "interview"],
    [IPC.LOAD_SECURITY_CHECK, "local"],
    [IPC.LOAD_LANGUAGE_SELECTION, "local"],
    [IPC.RECHECK_SYSTEM, "local"],
    [IPC.AUTH_LOGOUT, "local"],
    [IPC.START_INTERVIEW, "local"],
  ];
  for (const [channel, from] of exits) {
    const g = load();
    g.stage = "identity";
    await (from === "interview" ? g.callFromInterview(channel) : g.call(channel));
    assert.ok(g.names().includes("guard.stop"), channel);
    assert.strictEqual(g.stage, null, channel);
  }
});

test("guard status and a recheck are served by the guard", async () => {
  const g = load();
  g.stage = "role";
  assert.deepStrictEqual(await g.call(IPC.GET_GUARD_STATUS), guardState("clear", "role"));
  const blocked = guardState("blocked", "role", []);
  g.check = async () => blocked;
  assert.deepStrictEqual(await g.call(IPC.RECHECK_GUARD), blocked);
  assert.ok(g.names().includes("guard.checkNow"));
});

test("Start Interview stays on the dashboard when no attempts are left", async () => {
  const g = load();
  g.profile = {
    success: true,
    data: { interview_attempts_remaining: 0, max_interviews_allowed: 3 },
  };
  await g.call(IPC.START_INTERVIEW);
  assert.deepStrictEqual(
    g.calls.find((c) => c[0] === "loadDashboard"),
    ["loadDashboard", "exhausted"]
  );
  assert.ok(!g.names().includes("loadSecurityCheck"));

  for (const profile of [
    { success: false },
    { success: true, data: { interview_attempts_remaining: 1 } },
  ]) {
    const next = load();
    next.profile = profile;
    await next.call(IPC.START_INTERVIEW);
    assert.ok(next.names().includes("loadSecurityCheck"), JSON.stringify(profile));
  }
});

test("the site can back out of an interview that never started, in order", async () => {
  const g = load();
  g.active = true;
  await g.callFromInterview(IPC.ABORT_INTERVIEW, { reason: "attempts-exhausted" });
  const names = g.names();
  assert.ok(names.indexOf("detection.stop") < names.indexOf("endInterview"));
  assert.ok(names.indexOf("endInterview") < names.indexOf("killAgent"));
  assert.deepStrictEqual(g.calls.at(-1), ["loadDashboard", "exhausted"]);
});

test("once the interview is running the site can not back out of it", async () => {
  const g = load();
  g.stage = "role";
  await g.call(IPC.PROCEED_TO_INTERVIEW, { is_custom_role: false });
  g.active = true;
  await g.callFromInterview(IPC.PROCTORING_START, { sessionId: "s1" });
  await g.callFromInterview(IPC.ABORT_INTERVIEW, { reason: "start-failed" });
  assert.ok(!g.names().includes("endInterview"));
  assert.ok(!g.names().includes("loadDashboard"));
});

test("proctoring start hands the site's ids to detection", async () => {
  const g = load();
  g.active = true;
  await g.callFromInterview(IPC.PROCTORING_START, { sessionId: "s1", interviewId: 42 });
  assert.deepStrictEqual(
    g.calls.find((c) => c[0] === "setSessionContext"),
    ["setSessionContext", { sessionId: "s1", interviewId: null }]
  );
});

test("proctoring start refused outside a locked interview stores no ids", async () => {
  const g = load();
  await g.callFromInterview(IPC.PROCTORING_START, { sessionId: "s1" });
  assert.ok(!g.names().includes("setSessionContext"));
});

test("the violation simulator is refused without DEVTOOLS", async () => {
  const g = load();
  g.active = true;
  const result = await g.callFromInterview(IPC.DEV_SIMULATE_VIOLATION, "blocked_app");
  assert.strictEqual(result.ok, false);
  assert.ok(!g.names().includes("sendViolation"));
});

test("the dashboard can not be opened over a locked interview", async () => {
  const g = load();
  g.active = true;
  await g.callFromInterview(IPC.VIEW_DASHBOARD);
  await g.call(IPC.LOAD_DASHBOARD);
  assert.ok(!g.names().includes("loadDashboard"));
  assert.ok(!g.names().includes("killAgent"));

  g.unavailable = true;
  await g.call(IPC.LOAD_DASHBOARD);
  assert.deepStrictEqual(g.calls.at(-1), ["loadDashboard", "startFailed"]);
  assert.ok(g.names().includes("endInterview"));
});

test("the scorecard leaves only once the lockdown is fully released", async () => {
  const g = load();
  g.active = true;
  let release;
  g.release = new Promise((resolve) => (release = resolve));
  g.callFromInterview(IPC.INTERVIEW_COMPLETE, { reason: "completed" });
  g.callFromInterview(IPC.INTERVIEW_COMPLETE, { reason: "completed" });
  const leaving = g.callFromInterview(IPC.VIEW_DASHBOARD);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!g.names().includes("loadDashboard"));
  assert.ok(!g.names().includes("killAgent"), "a repeated signal waits for the first release");
  assert.strictEqual(g.names().filter((n) => n === "endInterview").length, 1);
  release();
  await leaving;
  const names = g.names();
  assert.ok(names.indexOf("killAgent") < names.indexOf("loadDashboard"));
});
