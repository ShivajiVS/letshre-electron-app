"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { createLockdownGuard, releaseLock } = require("../src/main/lockdownGuard");

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.state = {
      minimized: false,
      fullScreen: false,
      kiosk: false,
      alwaysOnTop: false,
      minimizable: true,
      maximizable: true,
      resizable: true,
      movable: true,
      destroyed: false,
    };
    this.focused = 0;
  }
  isMinimized() {
    return this.state.minimized;
  }
  isFullScreen() {
    return this.state.fullScreen;
  }
  isKiosk() {
    return this.state.kiosk;
  }
  isAlwaysOnTop() {
    return this.state.alwaysOnTop;
  }
  isMinimizable() {
    return this.state.minimizable;
  }
  isMaximizable() {
    return this.state.maximizable;
  }
  isResizable() {
    return this.state.resizable;
  }
  isDestroyed() {
    return this.state.destroyed;
  }
  restore() {
    this.state.minimized = false;
  }
  focus() {
    this.focused++;
  }
  moveTop() {}
  setMinimizable(v) {
    this.state.minimizable = v;
  }
  setMaximizable(v) {
    this.state.maximizable = v;
  }
  setResizable(v) {
    this.state.resizable = v;
  }
  setMovable(v) {
    this.state.movable = v;
  }
  setKiosk(v) {
    this.state.kiosk = v;
  }
  setFullScreen(v) {
    this.state.fullScreen = v;
  }
  setAlwaysOnTop(v) {
    this.state.alwaysOnTop = v;
  }
}

const LOCKED = {
  minimized: false,
  fullScreen: true,
  kiosk: true,
  alwaysOnTop: true,
  minimizable: false,
  maximizable: false,
  resizable: false,
  movable: false,
  destroyed: false,
};

function setup() {
  const win = new FakeWindow();
  const violations = [];
  const warnings = [];
  const guard = createLockdownGuard(win, {
    onViolation: (event, severity) => violations.push({ event, severity }),
    log: { warn: (msg) => warnings.push(msg) },
    watchdogMs: 5,
  });
  return { win, guard, violations, warnings };
}

test("start locks every window property", () => {
  const { win, guard } = setup();
  guard.start();
  try {
    assert.deepStrictEqual(win.state, LOCKED);
  } finally {
    guard.stop();
  }
});

test("a minimize is undone and reported", () => {
  const { win, guard, violations } = setup();
  guard.start();
  try {
    win.state.minimized = true;
    win.emit("minimize", { preventDefault() {} });

    assert.deepStrictEqual(win.state, LOCKED);
    assert.ok(win.focused > 0);
    assert.deepStrictEqual(violations, [{ event: "Window minimize attempt", severity: "high" }]);
  } finally {
    guard.stop();
  }
});

test("leaving fullscreen is undone and reported", () => {
  const { win, guard, violations } = setup();
  guard.start();
  try {
    win.state.fullScreen = false;
    win.state.maximizable = true;
    win.emit("leave-full-screen");

    assert.deepStrictEqual(win.state, LOCKED);
    assert.strictEqual(violations[0].event, "Fullscreen exit attempt");
  } finally {
    guard.stop();
  }
});

test("always-on-top dropped by a fullscreen transition is restored without a violation", () => {
  const { win, guard, violations } = setup();
  guard.start();
  try {
    win.state.alwaysOnTop = false;
    win.emit("always-on-top-changed", {}, false);

    assert.strictEqual(win.state.alwaysOnTop, true);
    assert.deepStrictEqual(violations, []);
  } finally {
    guard.stop();
  }
});

test("losing focus pulls the window back in front", () => {
  const { win, guard } = setup();
  guard.start();
  try {
    win.emit("blur");
    assert.ok(win.focused > 0);
  } finally {
    guard.stop();
  }
});

test("the watchdog repairs drift no event reported", async () => {
  const { win, guard, warnings } = setup();
  guard.start();
  try {
    win.state.alwaysOnTop = false;
    win.state.resizable = true;
    await new Promise((r) => setTimeout(r, 30));

    assert.deepStrictEqual(win.state, LOCKED);
    assert.strictEqual(warnings.length, 1, "a lost property is logged once, not every tick");
    assert.match(warnings[0], /always-on-top/);
  } finally {
    guard.stop();
  }
});

test("stop detaches every listener and the watchdog", async () => {
  const { win, guard, violations } = setup();
  guard.start();
  guard.stop();

  assert.strictEqual(win.eventNames().length, 0);

  win.state.fullScreen = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(win.state.fullScreen, false, "nothing re-locks after stop");
  assert.deepStrictEqual(violations, []);
});

test("releaseLock hands the candidate a normal window back", () => {
  const win = new FakeWindow();
  Object.assign(win.state, LOCKED);

  releaseLock(win);

  assert.deepStrictEqual(win.state, {
    ...LOCKED,
    fullScreen: false,
    kiosk: false,
    alwaysOnTop: false,
    minimizable: true,
    maximizable: true,
    resizable: true,
    movable: true,
  });
});

test("a destroyed window stops the guard instead of throwing", async () => {
  const { win, guard } = setup();
  guard.start();
  win.state.destroyed = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(guard.check(), []);
});

const WINDOW_MANAGER = fs.readFileSync(
  path.join(__dirname, "../src/main/windowManager.js"),
  "utf8"
);

test("the interview lockdown is held by the guard, not set once", () => {
  const fn = WINDOW_MANAGER.match(/function lockdownForInterview\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate lockdownForInterview()");
  assert.match(fn[1], /createLockdownGuard\(/);
  assert.match(fn[1], /lockdownGuard\.start\(\)/);
  assert.doesNotMatch(WINDOW_MANAGER, /setKiosk\(true\)/, "only lockdownGuard applies the lock");
});

test("ending the interview stops the guard", () => {
  const fn = WINDOW_MANAGER.match(/function endInterview\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate endInterview()");
  assert.match(fn[1], /_releaseLockdown\(\)/);
});

test("only the interview ending or a confirmed exit unlocks the window", () => {
  const callers = [...WINDOW_MANAGER.matchAll(/_releaseLockdown\(\)/g)].length;
  // The definition, endInterview() and the confirmed-exit branch of the close dialog.
  assert.strictEqual(callers, 3);
  assert.doesNotMatch(WINDOW_MANAGER, /enforceViolation/);
  const checks = fs.readFileSync(path.join(__dirname, "../src/detector/systemChecks.js"), "utf8");
  assert.doesNotMatch(checks, /windowManager/, "detection must never reach into the window lock");
});

const IPC_HANDLERS = fs.readFileSync(path.join(__dirname, "../src/main/ipcHandlers.js"), "utf8");

test("recording only starts for an interview that is locked down", () => {
  const handler = IPC_HANDLERS.match(/registerHandler\(IPC\.PROCTORING_START[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, "could not locate the proctoring-start handler");
  const guard = handler[0].indexOf("if (!getIsInterviewActive())");
  assert.ok(guard > -1, "proctoring-start must check the lockdown");
  assert.ok(guard < handler[0].indexOf("screenRecorder.start("), "check before recording");
  assert.match(handler[0], /_leaveInterviewFlowToDashboard\(/);
});

test("a finished interview page cannot be reloaded into a new one", () => {
  assert.match(
    WINDOW_MANAGER,
    /const isReload =[\s\S]*?!isInterviewActive[\s\S]*?_isInterviewPage/
  );
  assert.match(WINDOW_MANAGER, /\|\| isReload\)/);
});

test("each interview registers its own reference face", () => {
  const fn = WINDOW_MANAGER.match(/function lockdownForInterview\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.match(fn[1], /removeItem\('face_registered'\)/);
  assert.match(fn[1], /removeItem\('face_registered_for'\)/);
});
