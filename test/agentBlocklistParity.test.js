/**
 * agent.py flags renamed copies of blocked apps from its own copy of the
 * Windows blocklist, so it has to match appList.js name for name.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { ALL_BLOCKED_APPS } = require("../src/shared/appList");

const source = fs.readFileSync(path.join(__dirname, "..", "agent.py"), "utf8");

function agentBlocklist() {
  const block = source.match(/^RENAMED_APP_BLOCKLIST\s*=\s*frozenset\(\{([\s\S]*?)\}\)/m);
  assert.ok(block, "RENAMED_APP_BLOCKLIST = frozenset({...}) not found in agent.py");
  return [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

test("agent.py's renamed-app blocklist has no duplicates", () => {
  const names = agentBlocklist();
  assert.strictEqual(new Set(names).size, names.length);
});

test("agent.py's renamed-app blocklist equals appList's Windows image names", () => {
  const windows = [...new Set(ALL_BLOCKED_APPS.filter((n) => n.endsWith(".exe")))].sort();
  assert.ok(windows.length > 0);
  assert.deepStrictEqual([...agentBlocklist()].sort(), windows);
});

test("agent.py's renamed-app blocklist is lowercase", () => {
  for (const name of agentBlocklist()) {
    assert.strictEqual(name, name.toLowerCase());
  }
});
