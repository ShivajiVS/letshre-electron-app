"use strict";

const { test, mock, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const axios = require("axios");

const { loadSystemChecks, CLEAN_AGENT } = require("./_preflightHarness");
const {
  IPC,
  DETECTION_INTERVAL_MS,
  MAX_UNACKED_VIOLATIONS,
  VIOLATION_COOLDOWN_MS,
} = require("../src/shared/constants");
const { CODE } = require("../src/shared/violationCodes");
const { getDisplayName } = require("../src/shared/blocklist");

// A session token, so violations are posted to the backend too.
const PROTOCOL_HANDLER = require.resolve("../src/main/protocolHandler");
require.cache[PROTOCOL_HANDLER] = {
  id: PROTOCOL_HANDLER,
  filename: PROTOCOL_HANDLER,
  loaded: true,
  exports: { getCurrentAccessToken: () => "token" },
};
after(() => delete require.cache[PROTOCOL_HANDLER]);

const PAYLOAD_KEYS = [
  "id",
  "code",
  "category",
  "apps",
  "event",
  "severity",
  "count",
  "isHardBlock",
  "source",
  "timestamp",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeWin() {
  const webContents = new EventEmitter();
  const sent = [];
  webContents.send = (channel, payload) => sent.push({ channel, payload });
  return { webContents, sent, isDestroyed: () => false };
}

let h;
let win;
let posts;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  posts = [];
  mock.method(axios, "post", async (url, payload) => {
    if (url.endsWith("/interview/violation")) {
      posts.push(payload);
    }
    return { data: {} };
  });
  h = loadSystemChecks();
  win = fakeWin();
});

afterEach(() => {
  h.unload();
  mock.restoreAll();
  mock.timers.reset();
});

const violations = () =>
  win.sent.filter((m) => m.channel === IPC.PUSH_VIOLATION).map((m) => m.payload);

/** Starts a session and lets its immediate first tick finish. */
async function startSession() {
  h.checks.start(win);
  await flush();
}

async function tickTimes(n) {
  for (let i = 0; i < n; i++) {
    await h.checks._internal.runDetectionTick(win);
  }
}

const agentWith = (extra) => ({ ...CLEAN_AGENT(), ...extra });

// ─── Payload ─────────────────────────────────────────────────────────────────

test("a violation is pushed and posted with the structured payload", async () => {
  await startSession();
  h.checks.sendViolation(win, "Attempt to close interview window", "high", {
    code: CODE.CLOSE_ATTEMPT,
  });
  await flush();

  const [pushed] = violations();
  assert.deepStrictEqual(Object.keys(pushed), PAYLOAD_KEYS);
  assert.match(pushed.id, UUID);
  assert.strictEqual(pushed.code, CODE.CLOSE_ATTEMPT);
  assert.strictEqual(pushed.category, null);
  assert.deepStrictEqual(pushed.apps, []);
  assert.strictEqual(pushed.event, "Attempt to close interview window");
  assert.strictEqual(pushed.severity, "high");
  assert.strictEqual(pushed.count, 1);
  assert.strictEqual(pushed.isHardBlock, true);
  assert.strictEqual(pushed.source, "electron");
  assert.ok(!Number.isNaN(Date.parse(pushed.timestamp)));

  assert.deepStrictEqual(posts, [pushed], "the backend gets the same payload, same id");
});

test("an unknown or missing code falls back to suspicious_activity", async () => {
  await startSession();
  h.checks.sendViolation(win, "Attempted protocol swap during active interview", "high");
  h.checks.sendViolation(win, "Something else", "medium", {
    code: "not_a_code",
    category: 7,
    apps: ["Zoom", "Zoom", "", 3],
  });

  const [first, second] = violations();
  assert.strictEqual(first.code, CODE.SUSPICIOUS_ACTIVITY);
  assert.strictEqual(second.code, CODE.SUSPICIOUS_ACTIVITY);
  assert.strictEqual(second.category, null);
  assert.deepStrictEqual(second.apps, ["Zoom"]);
});

test("cooldown and escalation stay keyed by event", async () => {
  await startSession();
  h.checks.sendViolation(win, "Fullscreen exit attempt", "medium", { code: CODE.FULLSCREEN_EXIT });
  h.checks.sendViolation(win, "Fullscreen exit attempt", "medium", { code: CODE.FULLSCREEN_EXIT });

  assert.strictEqual(violations().length, 1, "a repeat within the cooldown is dropped");
  assert.strictEqual(violations()[0].isHardBlock, false);
});

// ─── Codes per signal ────────────────────────────────────────────────────────

test("an external display is external_display", async () => {
  h.fake.hdmi = async () => ({ detected: true, status: "violation", reason: "External display" });
  await startSession();

  const [v] = violations();
  assert.strictEqual(v.code, CODE.EXTERNAL_DISPLAY);
  assert.strictEqual(v.category, "hdmi");
  assert.strictEqual(v.event, "External display");
});

test("more physical panels than displays is mirrored_display", async () => {
  h.fake.status = async () => agentWith({ physical_monitors: 2 });
  await startSession();

  const [v] = violations();
  assert.strictEqual(v.code, CODE.MIRRORED_DISPLAY);
  assert.strictEqual(v.category, "hdmi");
  assert.strictEqual(v.event, "Duplicate/mirrored display detected (2 physical monitors)");
});

test("blocked apps raise one violation per blocklist category", async () => {
  h.fake.processes = async () => ({
    found: ["zoom.exe", "teams.exe", "chrome.exe", "cluely.exe"],
    status: "clear",
  });
  await startSession();

  const meeting = [getDisplayName("zoom.exe"), getDisplayName("teams.exe")];
  assert.deepStrictEqual(
    violations().map(({ code, category, apps, event, severity }) => ({
      code,
      category,
      apps,
      event,
      severity,
    })),
    [
      {
        code: CODE.BLOCKED_APP,
        category: "meeting",
        apps: meeting,
        event: `Blocked application running during interview: ${meeting.join(", ")}`,
        severity: "high",
      },
      {
        code: CODE.BLOCKED_APP,
        category: "browser",
        apps: ["Google Chrome"],
        event: "Blocked application running during interview: Google Chrome",
        severity: "high",
      },
      {
        code: CODE.AI_TOOL,
        category: "ai",
        apps: ["Cluely"],
        event: "Blocked application running during interview: Cluely",
        severity: "high",
      },
    ]
  );
});

test("every distinct agent threat code is sent, not only the first threat", async () => {
  const threat = (type, severity, detail, process) => ({ type, severity, detail, process });
  h.fake.status = async () =>
    agentWith({
      safe_to_proceed: false,
      threats: [
        threat("ai_cheating_tool", "HIGH", "AI tool: Cluely", "Cluely.exe"),
        threat("transparent_overlay", "MEDIUM", "Overlay: ghost.exe", "ghost.exe"),
        threat("suspicious_dll", "MEDIUM", "Module in a.exe", "a.exe"),
        threat("suspicious_network", "HIGH", "b.exe connected out", "b.exe"),
        threat("remote_session", "HIGH", "Remote desktop session"),
      ],
    });
  await startSession();

  assert.deepStrictEqual(
    violations().map(({ code, category, apps, event, severity }) => ({
      code,
      category,
      apps,
      event,
      severity,
    })),
    [
      {
        code: CODE.AI_TOOL,
        category: "agent",
        apps: ["Cluely"],
        event: "AI tool detected: Cluely",
        severity: "high",
      },
      {
        code: CODE.OVERLAY,
        category: "agent",
        apps: ["ghost.exe"],
        event: "See-through overlay window detected: ghost.exe",
        severity: "medium",
      },
      {
        code: CODE.SUSPICIOUS_ACTIVITY,
        category: "agent",
        apps: ["a.exe", "b.exe"],
        event: "Suspicious activity detected: a.exe, b.exe",
        severity: "high",
      },
      {
        code: CODE.REMOTE_SESSION,
        category: "agent",
        apps: [],
        event: "Remote desktop session detected",
        severity: "high",
      },
    ]
  );
});

test("a virtual camera warns first and hard blocks on repeat, without its device name", async () => {
  h.fake.status = async () =>
    agentWith({
      safe_to_proceed: false,
      threats: [
        {
          type: "virtual_camera",
          severity: "MEDIUM",
          detail: "Virtual camera detected: OBS Virtual Camera",
        },
      ],
    });
  let now = Date.now();
  mock.method(Date, "now", () => now);
  await startSession();
  now += VIOLATION_COOLDOWN_MS + 1;
  await tickTimes(1);

  const [first, second] = violations();
  assert.strictEqual(first.code, CODE.VIRTUAL_CAMERA);
  assert.strictEqual(first.category, "agent");
  assert.strictEqual(first.event, "Virtual camera detected");
  assert.strictEqual(first.severity, "medium");
  assert.strictEqual(first.isHardBlock, false);
  assert.strictEqual(second.isHardBlock, true);
});

test("an agent threat's own detail never leaves the machine", async () => {
  h.fake.status = async () =>
    agentWith({
      safe_to_proceed: false,
      threats: [
        {
          type: "ai_cheating_tool",
          severity: "HIGH",
          detail: "AI cheating tool detected (install path): at 'C:\\Users\\alice\\AppData\\p.exe'",
          process: "⠀.exe",
          display_name: "parakeetai-desktop",
          pid: 9,
        },
        { type: "suspicious_window_title", severity: "HIGH", detail: "Window 'alice - notes'" },
      ],
    });
  await startSession();

  const sent = JSON.stringify([...violations(), ...posts]);
  assert.ok(!sent.includes("alice"), sent);
  assert.deepStrictEqual(
    violations().map((v) => v.event),
    ["AI tool detected: parakeetai-desktop", "Suspicious activity detected"]
  );
});

test("an extra display is a strike for the site, never a hard block, even when it stays", async () => {
  await startSession();
  let now = Date.now();
  mock.method(Date, "now", () => now);
  const display = { code: CODE.EXTERNAL_DISPLAY, category: "hdmi" };
  h.checks.sendViolation(win, "External display", "high", display);
  now += VIOLATION_COOLDOWN_MS + 1;
  h.checks.sendViolation(win, "External display", "high", display);
  h.checks.sendViolation(win, "Mirrored", "high", {
    code: CODE.MIRRORED_DISPLAY,
    category: "hdmi",
  });

  assert.deepStrictEqual(
    violations().map(({ code, count, isHardBlock }) => ({ code, count, isHardBlock })),
    [
      { code: CODE.EXTERNAL_DISPLAY, count: 1, isHardBlock: false },
      { code: CODE.EXTERNAL_DISPLAY, count: 2, isHardBlock: false },
      { code: CODE.MIRRORED_DISPLAY, count: 1, isHardBlock: false },
    ]
  );
});

test("threats on a scan the agent still calls safe raise nothing", async () => {
  h.fake.status = async () =>
    agentWith({
      safe_to_proceed: true,
      threats: [{ type: "virtual_machine", severity: "HIGH", detail: "VM" }],
    });
  await startSession();

  assert.deepStrictEqual(violations(), []);
});

test("checks that keep failing escalate: agent_unreachable for the agent, check_unverified otherwise", async () => {
  h.fake.hdmi = async () => ({ detected: false, status: "indeterminate" });
  h.fake.processes = async () => ({ found: [], status: "indeterminate" });
  h.fake.status = async () => {
    throw new Error("agent down");
  };
  await startSession();
  await tickTimes(2);

  assert.deepStrictEqual(
    violations().map(({ code, category }) => ({ code, category })),
    [
      { code: CODE.CHECK_UNVERIFIED, category: "hdmi" },
      { code: CODE.CHECK_UNVERIFIED, category: null },
      { code: CODE.AGENT_UNREACHABLE, category: "agent" },
    ]
  );
});

test("an unknown physical monitor count escalates as check_unverified on hdmi", async () => {
  h.fake.status = async () => agentWith({ physical_monitors: null });
  await startSession();
  await tickTimes(2);

  assert.deepStrictEqual(
    violations().map(({ code, category }) => ({ code, category })),
    [{ code: CODE.CHECK_UNVERIFIED, category: "hdmi" }]
  );
});

// ─── Hand-off ────────────────────────────────────────────────────────────────

test("start runs the first detection tick immediately, then on the interval", async () => {
  let scans = 0;
  h.fake.hdmi = async () => {
    scans += 1;
    return { detected: true, status: "violation", reason: "External display" };
  };
  await startSession();

  assert.strictEqual(scans, 1, "no timer has fired yet");
  assert.strictEqual(violations().length, 1);

  mock.timers.tick(DETECTION_INTERVAL_MS);
  await flush();
  assert.strictEqual(scans, 2);
});

test("starting twice on one window is a no-op, and stopping twice is safe", async () => {
  let scans = 0;
  h.fake.hdmi = async () => {
    scans += 1;
    return { detected: false, status: "clear" };
  };
  h.checks.start(win);
  h.checks.start(win);
  await flush();

  assert.strictEqual(scans, 1);
  assert.strictEqual(win.webContents.listenerCount("did-finish-load"), 1);

  h.checks.stop();
  h.checks.stop();
  assert.strictEqual(h.checks.isSessionActive(), false);
  assert.strictEqual(win.webContents.listenerCount("did-finish-load"), 0);

  mock.timers.tick(DETECTION_INTERVAL_MS * 3);
  await flush();
  assert.strictEqual(scans, 1, "no tick after stop");
});

// ─── Acknowledgement and redelivery ──────────────────────────────────────────

const redelivered = () => violations().filter((v) => v.redelivered);

test("an ack by id removes only that violation; an ack without one removes all", async () => {
  await startSession();
  h.checks.sendViolation(win, "Fullscreen exit attempt", "medium");
  h.checks.sendViolation(win, "Window minimize attempt", "high");
  h.checks.sendViolation(win, "Attempt to close interview window", "high");
  const [a, b, c] = violations();

  h.checks.acknowledgeViolation(a.id);
  win.webContents.emit("did-finish-load");
  assert.deepStrictEqual(
    redelivered().map((v) => v.id),
    [b.id, c.id]
  );

  h.checks.acknowledgeViolation();
  win.webContents.emit("did-finish-load");
  assert.strictEqual(redelivered().length, 2, "nothing left to redeliver");
});

test("a page load resends every unacknowledged violation in order, with the same ids", async () => {
  await startSession();
  h.checks.sendViolation(win, "Fullscreen exit attempt", "medium", { code: CODE.FULLSCREEN_EXIT });
  h.checks.sendViolation(win, "Window minimize attempt", "high", { code: CODE.WINDOW_MINIMIZE });
  const sent = violations();

  win.webContents.emit("did-finish-load");
  await flush();

  assert.deepStrictEqual(
    redelivered(),
    sent.map((v) => ({ ...v, redelivered: true }))
  );
  assert.strictEqual(posts.length, 2, "redelivery is not posted to the backend again");
});

test("the unacknowledged store keeps only the newest MAX_UNACKED_VIOLATIONS", async () => {
  await startSession();
  for (let i = 0; i < MAX_UNACKED_VIOLATIONS + 5; i++) {
    h.checks.sendViolation(win, `violation ${i}`, "medium");
  }
  const sent = violations();

  win.webContents.emit("did-finish-load");

  assert.deepStrictEqual(
    redelivered().map((v) => v.id),
    sent.slice(5).map((v) => v.id)
  );
});

test("stop and resetState forget unacknowledged violations", async () => {
  await startSession();
  h.checks.sendViolation(win, "Window minimize attempt", "high");
  h.checks.stop();
  h.checks.start(win);
  await flush();
  win.webContents.emit("did-finish-load");
  assert.deepStrictEqual(redelivered(), []);

  h.checks.sendViolation(win, "Attempt to close interview window", "high");
  h.checks.resetState();
  h.checks.start(win);
  await flush();
  win.webContents.emit("did-finish-load");
  assert.deepStrictEqual(redelivered(), []);
});
