"use strict";

// contract/interview-contract.json is what the interview site builds against.
// These fail when the code moves and the contract doesn't, or the other way round.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const contract = require("../contract/interview-contract.json");
const { CODE, isStrikeCode } = require("../src/shared/violationCodes");
const { IPC } = require("../src/shared/constants");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("contract has an integer version", () => {
  assert.ok(Number.isInteger(contract.version) && contract.version >= 1);
});

test("contract lists exactly the codes in violationCodes.js", () => {
  const inContract = contract.violationCodes.map((c) => c.code).sort();
  assert.deepStrictEqual(inContract, Object.values(CODE).sort());
});

test("neverHardBlock matches the app's strike codes", () => {
  for (const { code, neverHardBlock } of contract.violationCodes) {
    assert.strictEqual(neverHardBlock, isStrikeCode(code), code);
  }
});

test("every treatAs value is defined", () => {
  for (const { code, treatAs } of contract.violationCodes) {
    assert.ok(treatAs in contract.treatAsValues, `${code}: unknown treatAs "${treatAs}"`);
  }
});

test("contract methods are exactly the interview-scoped channels", () => {
  const re = /register(?:Handler|Send)\(\s*IPC\.([A-Z0-9_]+)\s*,\s*SCOPE\.INTERVIEW\s*,/g;
  const scoped = [...read("src/main/ipcHandlers.js").matchAll(re)].map((m) => m[1]).sort();
  const inContract = contract.electronAPI.methods.map((m) => m.channelKey).sort();
  assert.deepStrictEqual(inContract, scoped);
});

test("contract channel names and kinds match constants.js and preload.js", () => {
  const preload = read("preload.js");
  for (const m of contract.electronAPI.methods) {
    assert.strictEqual(IPC[m.channelKey], m.channel, m.name);
    const call = m.kind === "invoke" ? "safeInvoke" : "safeSend";
    const exposed = new RegExp(
      `\\b${m.name}:\\s*\\([^)]*\\)\\s*=>\\s*${call}\\(IPC\\.${m.channelKey}\\b`
    );
    assert.match(preload, exposed, `preload.js should expose ${m.name} via ${call}`);
  }
  for (const e of contract.electronAPI.events) {
    assert.strictEqual(IPC[e.channelKey], e.channel, e.name);
    assert.match(preload, new RegExp(`\\b${e.name}:`), `preload.js should expose ${e.name}`);
  }
});

test("sessionStorage handoff keys match what windowManager.js injects", () => {
  const text = read("src/main/windowManager.js");
  const set = [...text.matchAll(/sessionStorage\.setItem\('([\w-]+)'/g)].map((m) => m[1]).sort();
  const cleared = [...text.matchAll(/sessionStorage\.removeItem\('([\w-]+)'/g)]
    .map((m) => m[1])
    .sort();
  assert.deepStrictEqual(contract.sessionStorage.set.map((k) => k.key).sort(), set);
  assert.deepStrictEqual([...contract.sessionStorage.cleared].sort(), cleared);
});

test("every documented reason survives the app's reason sanitiser", () => {
  const safe = /^[\w:-]{1,40}$/;
  for (const list of [contract.reasons.interviewComplete, contract.reasons.abortInterview]) {
    for (const { reason } of list) {
      assert.match(reason, safe);
    }
  }
});
