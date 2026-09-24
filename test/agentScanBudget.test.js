/**
 * agent.py runs its checks under SCAN_BUDGET_S and marks late ones as errors.
 * That only helps if the budget, plus the pipe round trip, lands before
 * Electron gives up on the scan, and no single wait inside a check outlasts it.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { AGENT_SCAN_TIMEOUT_MS } = require("../src/shared/constants");

const IPC_MARGIN_MS = 1500;

const source = fs.readFileSync(path.join(__dirname, "..", "agent.py"), "utf8");

const constants = new Map(
  [...source.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(\d+(?:\.\d+)?)\s*(?:#.*)?$/gm)].map((m) => [
    m[1],
    Number(m[2]),
  ])
);

function seconds(token) {
  if (/^\d+(\.\d+)?$/.test(token)) {
    return Number(token);
  }
  assert.ok(constants.has(token), `timeout=${token} is not a numeric module constant in agent.py`);
  return constants.get(token);
}

const budgetS = constants.get("SCAN_BUDGET_S");
const timeouts = [...source.matchAll(/timeout=([A-Za-z0-9_.]+)/g)].map((m) => ({
  token: m[1],
  s: seconds(m[1]),
}));

test("agent.py declares a numeric scan budget", () => {
  assert.strictEqual(typeof budgetS, "number");
  assert.ok(budgetS > 0);
});

test("the scan budget leaves room for IPC inside AGENT_SCAN_TIMEOUT_MS", () => {
  assert.ok(
    budgetS * 1000 + IPC_MARGIN_MS <= AGENT_SCAN_TIMEOUT_MS,
    `SCAN_BUDGET_S (${budgetS}s) + ${IPC_MARGIN_MS}ms margin exceeds ${AGENT_SCAN_TIMEOUT_MS}ms`
  );
});

test("every timeout inside the checks is shorter than the scan budget", () => {
  assert.ok(timeouts.length >= 4, "expected to find the checks' subprocess timeouts");
  for (const { token, s } of timeouts) {
    assert.ok(s < budgetS, `timeout=${token} (${s}s) is not below SCAN_BUDGET_S (${budgetS}s)`);
    assert.ok(s * 1000 < AGENT_SCAN_TIMEOUT_MS, `timeout=${token} exceeds AGENT_SCAN_TIMEOUT_MS`);
  }
});
