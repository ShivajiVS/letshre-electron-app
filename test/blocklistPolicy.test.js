"use strict";

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("child_process");

const blocklist = require("../src/shared/blocklist");
const appList = require("../src/shared/appList");
const { mapProcesses } = require("../src/detector/preflightVerdict");
const { checkProcesses, invalidateProcessCache } = require("../src/detector/mirrorDetector");
const { killSingleProcess } = require("../src/main/processKiller");
const blocklistPolicy = require("../src/main/blocklistPolicy");

const origExecFile = childProcess.execFile;
const origGet = blocklistPolicy._config.get;
const origPath = blocklistPolicy._config.path;

test.afterEach(() => {
  childProcess.execFile = origExecFile;
  blocklistPolicy._config.get = origGet;
  blocklistPolicy._config.path = origPath;
  blocklistPolicy.reset();
});

const apply = (raw) => blocklist.applyPolicy(blocklist.validatePolicy(raw));
const card = (id, procs) =>
  mapProcesses({ status: "violation", details: { processes: procs } }).find((v) => v.id === id);

test("defaults are appList's built-ins", () => {
  const lists = blocklist.getLists();
  assert.deepStrictEqual(lists.meeting, appList.MEETING_APPS);
  assert.deepStrictEqual(lists.wireless, appList.CASTING_APPS);
  assert.deepStrictEqual(lists.ai, appList.AI_CHEATING_APPS);
  assert.deepStrictEqual(
    [...blocklist.getAllBlocked()].sort(),
    [...appList.ALL_BLOCKED_APPS].sort()
  );
  assert.strictEqual(blocklist.isPolicyApplied(), false);
});

test("validation drops malformed names, unknown categories, protected names and duplicates", () => {
  const policy = blocklist.validatePolicy({
    allow: ["Chrome.exe", "../evil", "a/b.exe", 42, "x".repeat(121), ""],
    block: [
      { name: "CheatApp.exe", category: "ai", displayName: "Cheat\u0007 App" },
      { name: "cheatapp.exe", category: "meeting" },
      { name: "rogue.exe", category: "games" },
      { name: "explorer.exe", category: "screen" },
      { name: "LetsHyre Secure Interview.exe", category: "screen" },
      { name: "bad\\name.exe", category: "screen" },
      null,
    ],
  });
  assert.deepStrictEqual(policy.allow, ["chrome.exe"]);
  assert.deepStrictEqual(policy.block, [
    { name: "cheatapp.exe", category: "ai", displayName: "Cheat App" },
  ]);
  assert.strictEqual(policy.dropped, 11);
});

test("validation rejects a response that isn't a policy", () => {
  for (const raw of [null, "x", [], { allow: "chrome.exe" }, { block: {} }]) {
    assert.strictEqual(blocklist.validatePolicy(raw), null, JSON.stringify(raw));
  }
});

test("each list is capped at 200 entries", () => {
  const names = Array.from({ length: 250 }, (_, i) => `app${i}.exe`);
  const policy = blocklist.validatePolicy({
    allow: names,
    block: names.map((name) => ({ name, category: "screen" })),
  });
  assert.strictEqual(policy.allow.length, 200);
  assert.strictEqual(policy.block.length, 200);
  assert.strictEqual(policy.dropped, 100);
});

test("allow removes built-ins but never an AI tool", () => {
  const summary = apply({ allow: ["slack.exe", "chrome.exe", "cluely.exe"] });
  assert.deepStrictEqual(summary, { removed: 2, added: 0 });
  assert.strictEqual(blocklist.isBlocked("slack.exe"), false);
  assert.strictEqual(blocklist.isBlocked("chrome.exe"), false);
  assert.strictEqual(blocklist.isBlocked("cluely.exe"), true);
  assert.ok(blocklist.getLists().ai.includes("cluely.exe"));
  assert.strictEqual(blocklist.isPolicyApplied(), true);
});

test("extras land on their category's card, wireless extras on the casting card", () => {
  apply({
    block: [
      { name: "meetly.exe", category: "meeting" },
      { name: "shady.exe", category: "ai", displayName: "Shady AI" },
      { name: "beamer.exe", category: "wireless" },
    ],
  });
  assert.deepStrictEqual(card("meeting", ["meetly.exe"]).blockedApps, ["meetly.exe"]);
  assert.deepStrictEqual(card("ai", ["shady.exe"]).blockedApps, ["shady.exe"]);
  assert.deepStrictEqual(card("wireless", ["beamer.exe"]).blockedApps, ["beamer.exe"]);
  assert.strictEqual(blocklist.getDisplayName("shady.exe"), "Shady AI");
  assert.strictEqual(blocklist.getDisplayName("meetly.exe"), "meetly.exe");
});

test("the process scan uses the effective lists", async () => {
  apply({ allow: ["chrome.exe"], block: [{ name: "shady.exe", category: "ai" }] });
  invalidateProcessCache();
  childProcess.execFile = (_bin, _args, cb) =>
    cb(null, '"chrome.exe","1","Console","1","1 K"\r\n"shady.exe","2","Console","1","1 K"\r\n');
  const { found } = await checkProcesses();
  assert.deepStrictEqual(found, ["shady.exe"]);
});

test("the kill whitelist follows the effective lists", async () => {
  const linux = { platform: "linux" };
  assert.strictEqual((await killSingleProcess("shady.exe", linux)).outcome, "not-blocked");
  apply({ allow: ["chrome.exe"], block: [{ name: "shady.exe", category: "screen" }] });
  assert.strictEqual((await killSingleProcess("shady.exe", linux)).outcome, "unsupported");
  assert.strictEqual((await killSingleProcess("chrome.exe", linux)).outcome, "not-blocked");
});

test("a fetched policy is applied and invalidates the process cache", async () => {
  let asked = null;
  blocklistPolicy._config.path = "/policy";
  blocklistPolicy._config.get = async (url, opts) => {
    asked = { url, opts };
    return { data: { allow: ["zoom.exe"], block: [{ name: "shady.exe", category: "ai" }] } };
  };

  invalidateProcessCache();
  childProcess.execFile = (_bin, _args, cb) => cb(null, '"zoom.exe","1","Console","1","1 K"\r\n');
  assert.deepStrictEqual((await checkProcesses()).found, ["zoom.exe"]);

  await blocklistPolicy.loadForInterview("tok");
  assert.match(asked.url, /\/policy$/);
  assert.strictEqual(asked.opts.headers.Authorization, "Bearer tok");
  assert.strictEqual(asked.opts.timeout, 5000);
  assert.strictEqual(blocklist.isBlocked("shady.exe"), true);
  assert.deepStrictEqual((await checkProcesses()).found, [], "cache was not served");
});

test("a failed or invalid fetch keeps the built-in lists", async () => {
  blocklistPolicy._config.path = "/policy";
  blocklistPolicy._config.get = async () => {
    throw new Error("network down");
  };
  await blocklistPolicy.loadForInterview("tok");
  assert.strictEqual(blocklist.isPolicyApplied(), false);

  blocklistPolicy._config.get = async () => ({ data: "<html>" });
  await blocklistPolicy.loadForInterview("tok");
  assert.strictEqual(blocklist.isPolicyApplied(), false);
  assert.strictEqual(blocklist.isBlocked("zoom.exe"), true);
});

test("no request is made when the endpoint is unset", async () => {
  blocklistPolicy._config.path = "";
  blocklistPolicy._config.get = async () => assert.fail("must not fetch");
  await blocklistPolicy.loadForInterview("tok");
  assert.strictEqual(blocklist.isPolicyApplied(), false);
});

test("a fetch that lands after reset is discarded", async () => {
  let release;
  blocklistPolicy._config.path = "/policy";
  blocklistPolicy._config.get = () =>
    new Promise((resolve) => {
      release = () => resolve({ data: { allow: ["zoom.exe"] } });
    });
  const loading = blocklistPolicy.loadForInterview("tok");
  blocklistPolicy.reset();
  release();
  await loading;
  assert.strictEqual(blocklist.isPolicyApplied(), false);
});

test("whenSettled waits for the fetch, but only up to its budget", async () => {
  blocklistPolicy._config.path = "/policy";
  blocklistPolicy._config.get = () => new Promise(() => {});
  blocklistPolicy.loadForInterview("tok");
  const started = Date.now();
  await blocklistPolicy.whenSettled(30);
  assert.ok(Date.now() - started < 1000);
});

// ─── IPC wiring

function loadIpcHandlers() {
  const handlers = new Map();
  const stub = (rel, exports) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  const noop = () => {};
  stub("electron", {
    app: { getVersion: () => "0.0.0", quit: noop },
    shell: {},
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => handlers.set(channel, fn),
    },
  });
  stub("../src/main/updater", {});
  stub("../src/main/screenRecorder", { registerRecorderIpc: noop });
  stub("../src/main/agentManager", { whenAgentReady: async () => true, killAgent: noop });
  stub("../src/main/windowManager", {
    clearCandidatePhoto: noop,
    clearInterviewSessionData: async () => {},
    loadDashboard: noop,
    loadSecurityCheck: noop,
    loadLanguageSelectionPage: noop,
    getWindow: () => null,
  });
  stub("../src/main/protocolHandler", {
    setInterviewSession: noop,
    resetInterviewSession: noop,
    getCurrentInterviewUrl: () => null,
  });
  stub("../src/main/localeManager", { getSupportedLocales: () => ["en"] });
  stub("../src/main/authManager", {
    logout: async () => ({ success: true }),
    getTokens: () => ({ accessToken: "tok", refreshToken: "r" }),
  });
  stub("../src/detector/systemChecks", {
    startPreProceedMonitor: noop,
    stopPreProceedMonitor: noop,
  });
  delete require.cache[require.resolve("../src/main/ipcScope")];
  delete require.cache[require.resolve("../src/main/ipcHandlers")];
  require("../src/main/ipcHandlers").registerIpcHandlers();

  const event = { senderFrame: { origin: "null", top: null } };
  return (channel, ...args) => handlers.get(channel)(event, ...args);
}

const { IPC } = require("../src/shared/constants");

test("GET_APP_LIST serves the effective lists and extras' display names", async () => {
  const call = loadIpcHandlers();
  apply({
    allow: ["chrome.exe"],
    block: [
      { name: "shady.exe", category: "ai", displayName: "Shady AI" },
      { name: "plain.exe", category: "browser" },
    ],
  });
  const list = await call(IPC.GET_APP_LIST);
  assert.ok(!list.browserApps.includes("chrome.exe"));
  assert.ok(list.browserApps.includes("plain.exe"));
  assert.ok(list.aiCheatingApps.includes("shady.exe"));
  assert.deepStrictEqual(list.castingApps, appList.CASTING_APPS);
  assert.strictEqual(list.displayNames["shady.exe"], "Shady AI");
  assert.strictEqual(list.displayNames["plain.exe"], "plain.exe");
  assert.strictEqual(list.displayNames["zoom.exe"], "Zoom");
});

test("Start Interview loads the policy; logout and leaving to the dashboard clear it", async () => {
  const call = loadIpcHandlers();
  blocklistPolicy._config.path = "/policy";
  blocklistPolicy._config.get = async () => ({ data: { allow: ["zoom.exe"] } });

  call(IPC.START_INTERVIEW);
  await blocklistPolicy.whenSettled(1000);
  assert.strictEqual(blocklist.isBlocked("zoom.exe"), false);

  await call(IPC.AUTH_LOGOUT);
  assert.strictEqual(blocklist.isPolicyApplied(), false);
  assert.strictEqual(blocklist.isBlocked("zoom.exe"), true);

  call(IPC.START_INTERVIEW);
  await blocklistPolicy.whenSettled(1000);
  assert.strictEqual(blocklist.isPolicyApplied(), true);
  call(IPC.LOAD_DASHBOARD);
  assert.strictEqual(blocklist.isPolicyApplied(), false);
});

test("a threat is named by the agent's display_name, else by its image", () => {
  const { getThreatDisplayName } = blocklist;
  assert.strictEqual(
    getThreatDisplayName({ process: "\u2800.exe", display_name: " parakeetai-desktop " }),
    "parakeetai-desktop"
  );
  assert.strictEqual(getThreatDisplayName({ process: "Zoom.exe" }), "Zoom");
  assert.strictEqual(getThreatDisplayName({ process: "notes.exe", display_name: "" }), "notes.exe");
  assert.strictEqual(getThreatDisplayName({}), "");
});
