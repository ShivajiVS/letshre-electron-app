"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createViolationSimulator } = require("../src/main/devViolations");
const { CODE } = require("../src/shared/violationCodes");

const quiet = { info: () => {}, warn: () => {} };

function simulator({ enabled = true, active = true, win = {} } = {}) {
  const sent = [];
  const simulate = createViolationSimulator({
    enabled,
    getWindow: () => win,
    isSessionActive: () => active,
    sendViolation: (...args) => sent.push(args),
    logger: quiet,
  });
  return { simulate, sent };
}

test("with DEVTOOLS off every code is refused and nothing is sent", () => {
  const { simulate, sent } = simulator({ enabled: false });
  for (const code of Object.values(CODE)) {
    assert.strictEqual(simulate(code).ok, false, code);
  }
  assert.deepStrictEqual(sent, []);
});

test("with DEVTOOLS on any known code goes through sendViolation", () => {
  const win = { id: 1 };
  const { simulate, sent } = simulator({ win });
  for (const code of Object.values(CODE)) {
    assert.deepStrictEqual(simulate(code), { ok: true }, code);
  }
  assert.strictEqual(sent.length, Object.values(CODE).length);
  const [target, event, severity, meta] = sent[0];
  assert.strictEqual(target, win);
  assert.match(event, /Simulated violation/);
  assert.strictEqual(severity, "high");
  assert.deepStrictEqual(meta, { code: Object.values(CODE)[0] });
});

test("an unknown code, or no running interview, is refused", () => {
  const { simulate, sent } = simulator();
  for (const code of ["nope", "", null, 7, { code: "blocked_app" }]) {
    assert.strictEqual(simulate(code).ok, false);
  }
  assert.strictEqual(simulator({ active: false }).simulate(CODE.BLOCKED_APP).ok, false);
  assert.strictEqual(simulator({ win: null }).simulate(CODE.BLOCKED_APP).ok, false);
  assert.deepStrictEqual(sent, []);
});

test("the IPC handler only enables the simulator for unpackaged DEVTOOLS runs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/ipcHandlers.js"), "utf8");
  assert.match(source, /enabled: DEVTOOLS_ENABLED && !app\.isPackaged/);
});
