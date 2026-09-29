"use strict";

const { test, describe, mock, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { loadSystemChecks } = require("./_preflightHarness");
const { IPC } = require("../src/shared/constants");
const { CODE } = require("../src/shared/violationCodes");

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ─── Pipe ────────────────────────────────────────────────────────────────────

test("an unsolicited agent message is emitted by type, even split across reads", () => {
  const { onAgentEvent, _internal } = require("../src/main/agentManager");
  const seen = [];
  const off = onAgentEvent("process_started", (msg) => seen.push(msg));
  _internal.consumeStdout('{"type":"process_started","name":"zoom.exe","pid":7}\n{"type":"proc');
  _internal.consumeStdout('ess_started","name":"teams.exe","pid":8}\n');
  off();
  _internal.consumeStdout('{"type":"process_started","name":"late.exe","pid":9}\n');
  assert.deepStrictEqual(
    seen.map((m) => m.name),
    ["zoom.exe", "teams.exe"]
  );
});

test("a reply that happens to carry a type is not treated as an event", () => {
  const { onAgentEvent, _internal } = require("../src/main/agentManager");
  const seen = [];
  const off = onAgentEvent("process_started", (msg) => seen.push(msg));
  _internal.consumeStdout('{"id":3,"type":"process_started","name":"x.exe","pid":1}\n');
  off();
  assert.deepStrictEqual(seen, []);
});

test("onProcessStarted passes on only well-formed events", () => {
  const MANAGER = require.resolve("../src/main/agentManager");
  const CLIENT = require.resolve("../src/detector/agentClient");
  const bus = new EventEmitter();
  const real = require.cache[MANAGER];
  require.cache[MANAGER] = {
    id: MANAGER,
    filename: MANAGER,
    loaded: true,
    exports: {
      getAgentSecret: () => "",
      sendAgentCommand: async () => null,
      onAgentEvent: (type, fn) => {
        bus.on(type, fn);
        return () => bus.off(type, fn);
      },
    },
  };
  delete require.cache[CLIENT];
  try {
    const { onProcessStarted } = require(CLIENT);
    const seen = [];
    const off = onProcessStarted((p) => seen.push(p));
    bus.emit("process_started", { type: "process_started", name: "zoom.exe", pid: 4, extra: 1 });
    bus.emit("process_started", { type: "process_started", name: "", pid: 5 });
    bus.emit("process_started", { type: "process_started", name: "a.exe", pid: "6" });
    bus.emit("process_started", { type: "process_started", pid: 7 });
    off();
    bus.emit("process_started", { type: "process_started", name: "b.exe", pid: 8 });
    assert.deepStrictEqual(seen, [{ name: "zoom.exe", pid: 4 }]);
  } finally {
    delete require.cache[CLIENT];
    if (real) {
      require.cache[MANAGER] = real;
    } else {
      delete require.cache[MANAGER];
    }
  }
});

// ─── Detection ───────────────────────────────────────────────────────────────

describe("live detection", () => {
  let h;
  let win;
  let ticks;
  let running = [];

  function fakeWin() {
    const webContents = new EventEmitter();
    const sent = [];
    webContents.send = (channel, payload) => sent.push({ channel, payload });
    return { webContents, sent, isDestroyed: () => false };
  }

  const violations = () =>
    win.sent.filter((m) => m.channel === IPC.PUSH_VIOLATION).map((m) => m.payload);

  const started = (name, pid = 100) => h.agentEvents.emit("process_started", { name, pid });

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    h = loadSystemChecks();
    win = fakeWin();
    ticks = 0;
    h.fake.processes = async () => {
      ticks += 1;
      return { found: running, status: "clear" };
    };
  });

  afterEach(() => {
    h.unload();
    mock.restoreAll();
    mock.timers.reset();
    running = [];
  });

  test("a blocked app starting mid-interview is flagged without waiting for the tick", async () => {
    h.checks.start(win);
    await flush();
    assert.strictEqual(ticks, 1);

    running = ["zoom.exe"];
    started("Zoom.exe");
    await flush();

    assert.strictEqual(ticks, 2);
    assert.strictEqual(h.fake.invalidations, 1, "the cached process list is skipped");
    const [v] = violations();
    assert.strictEqual(v.code, CODE.BLOCKED_APP);
    assert.strictEqual(v.category, "meeting");
  });

  test("an allowed process starting does not tick", async () => {
    h.checks.start(win);
    await flush();
    started("notepad.exe");
    started("svchost.exe");
    await flush();
    assert.strictEqual(ticks, 1);
  });

  test("starts during an extra tick are folded into one follow-up tick", async () => {
    h.checks.start(win);
    await flush();
    for (let i = 0; i < 5; i++) {
      started("teams.exe", 200 + i);
    }
    for (let i = 0; i < 5; i++) {
      await flush();
    }
    assert.strictEqual(ticks, 3);
  });

  test("a mac process name matches its .app blocklist entry", async () => {
    h.checks.start(win);
    await flush();
    started("zoom.us");
    await flush();
    assert.strictEqual(ticks, 2);
  });

  test("process starts are ignored before the session and after it ends", async () => {
    started("zoom.exe");
    await flush();
    assert.strictEqual(ticks, 0);

    h.checks.start(win);
    await flush();
    h.checks.stop();
    started("zoom.exe");
    await flush();
    assert.strictEqual(ticks, 1);
    assert.strictEqual(h.agentEvents.listenerCount("process_started"), 0);
  });

  test("the regular tick keeps running as the safety net", async () => {
    h.checks.start(win);
    await flush();
    const { DETECTION_INTERVAL_MS } = require("../src/shared/constants");
    mock.timers.tick(DETECTION_INTERVAL_MS);
    await flush();
    assert.strictEqual(ticks, 2);
  });
});
