"use strict";

const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { CODE } = require("../src/shared/violationCodes");

const OS_LOCKDOWN = require.resolve("../src/main/osLockdown");
const STUBBED = {
  agentManager: require.resolve("../src/main/agentManager"),
  logger: require.resolve("../src/main/logger"),
  electron: require.resolve("electron"),
};
const REAL_PLATFORM = process.platform;

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function load(platform = "win32") {
  setPlatform(platform);
  const agent = { sent: [], replies: {} };
  stub(STUBBED.agentManager, {
    sendAgentCommand: async (cmd, timeoutMs, args) => {
      agent.sent.push({ cmd, args });
      const reply = agent.replies[cmd];
      return typeof reply === "function" ? reply() : (reply ?? null);
    },
  });
  const noop = () => {};
  stub(STUBBED.logger, { info: noop, warn: noop, error: noop });
  const app = new EventEmitter();
  app.focusCalls = [];
  app.focus = (opts) => app.focusCalls.push(opts);
  stub(STUBBED.electron, { app });
  delete require.cache[OS_LOCKDOWN];
  return { lockdown: require(OS_LOCKDOWN), agent, app };
}

function fakeWin() {
  const win = new EventEmitter();
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1234n);
  Object.assign(win, {
    destroyed: false,
    shown: 0,
    focused: 0,
    workspaces: [],
    isDestroyed: () => win.destroyed,
    getNativeWindowHandle: () => handle,
    show: () => win.shown++,
    focus: () => win.focused++,
    setVisibleOnAllWorkspaces: (on, opts) => win.workspaces.push({ on, opts }),
  });
  return win;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let h;
afterEach(async () => {
  await h?.lockdown.stop();
  setPlatform(REAL_PLATFORM);
  mock.timers.reset();
  for (const id of [...Object.values(STUBBED), OS_LOCKDOWN]) {
    delete require.cache[id];
  }
});

test("Windows: the agent is given the window and the app's pid", async () => {
  h = load();
  h.agent.replies.lockdown_start = { active: true, keys_hooked: true };
  h.lockdown.start(fakeWin(), () => {});
  await flush();

  assert.deepStrictEqual(h.agent.sent[0], {
    cmd: "lockdown_start",
    args: { hwnd: 0x1234, pid: process.pid },
  });
});

test("Windows: focus and desktop events become violations the site decides on", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  h = load();
  const violations = [];
  h.agent.replies.lockdown_start = { active: true };
  h.agent.replies.lockdown_poll = () => ({
    active: true,
    events: [
      { type: "focus_lost", process: "chrome.exe" },
      { type: "focus_lost", process: "⠀.exe", display_name: "parakeetai-desktop" },
      { type: "virtual_desktop" },
    ],
  });
  h.lockdown.start(fakeWin(), (event, severity, meta) =>
    violations.push({ event, severity, meta })
  );
  await flush();
  mock.timers.tick(500);
  await flush();

  assert.deepStrictEqual(violations, [
    {
      event: "Left the interview window: Google Chrome",
      severity: "high",
      meta: { code: CODE.FOCUS_LOST, apps: ["Google Chrome"] },
    },
    {
      event: "Left the interview window: parakeetai-desktop",
      severity: "high",
      meta: { code: CODE.FOCUS_LOST, apps: ["parakeetai-desktop"] },
    },
    {
      event: "Switched to another virtual desktop",
      severity: "high",
      meta: { code: CODE.VIRTUAL_DESKTOP },
    },
  ]);
});

test("Windows: a restarted agent gets the lockdown again", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  h = load();
  h.agent.replies.lockdown_start = { active: true };
  h.agent.replies.lockdown_poll = { active: false };
  h.lockdown.start(fakeWin(), () => {});
  await flush();
  mock.timers.tick(500);
  await flush();
  mock.timers.tick(500);
  await flush();

  assert.deepStrictEqual(
    h.agent.sent.map((s) => s.cmd),
    ["lockdown_start", "lockdown_poll", "lockdown_start"]
  );
});

test("Windows: stop waits for the agent to let go", async () => {
  h = load();
  h.agent.replies.lockdown_start = { active: true };
  h.lockdown.start(fakeWin(), () => {});
  await flush();
  await h.lockdown.stop();

  assert.strictEqual(h.agent.sent.at(-1).cmd, "lockdown_stop");
});

test("macOS: the window is on every Space and focus is taken back when lost", async () => {
  h = load("darwin");
  const win = fakeWin();
  const violations = [];
  h.lockdown.start(win, (event, severity, meta) => violations.push({ event, meta }));

  assert.deepStrictEqual(win.workspaces[0], { on: true, opts: { visibleOnFullScreen: true } });
  h.app.emit("did-resign-active");
  assert.deepStrictEqual(h.app.focusCalls, [{ steal: true }]);
  assert.ok(win.focused > 0);
  assert.deepStrictEqual(violations, [
    { event: "Left the interview window", meta: { code: CODE.FOCUS_LOST } },
  ]);

  await h.lockdown.stop();
  h.app.emit("did-resign-active");
  assert.strictEqual(violations.length, 1, "no longer listening once stopped");
  assert.strictEqual(win.workspaces.at(-1).on, false);
  assert.deepStrictEqual(h.agent.sent, []);
});
