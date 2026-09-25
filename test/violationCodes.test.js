"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  CODE,
  codeForThreat,
  codeForProcessCategory,
  isKnownCode,
} = require("../src/shared/violationCodes");
const { CATEGORIES } = require("../src/shared/blocklist");

const ALL = Object.values(CODE);

test("codes are unique, frozen snake_case strings", () => {
  assert.ok(Object.isFrozen(CODE));
  assert.strictEqual(new Set(ALL).size, ALL.length);
  for (const code of ALL) {
    assert.match(code, /^[a-z]+(_[a-z]+)*$/);
  }
});

test("isKnownCode accepts exactly the codes", () => {
  for (const code of ALL) {
    assert.strictEqual(isKnownCode(code), true);
  }
  for (const other of ["", "BLOCKED_APP", "unknown", null, undefined, 1, {}]) {
    assert.strictEqual(isKnownCode(other), false);
  }
});

test("agent threat types map to their codes, anything else to suspicious_activity", () => {
  const expected = {
    ai_cheating_tool: CODE.AI_TOOL,
    transparent_overlay: CODE.OVERLAY,
    renamed_blocked_app: CODE.RENAMED_APP,
    remote_session: CODE.REMOTE_SESSION,
    virtual_machine: CODE.VIRTUAL_MACHINE,
    suspicious_dll: CODE.SUSPICIOUS_ACTIVITY,
    browser_automation: CODE.SUSPICIOUS_ACTIVITY,
    made_up: CODE.SUSPICIOUS_ACTIVITY,
  };
  for (const [type, code] of Object.entries(expected)) {
    assert.strictEqual(codeForThreat({ type }), code, type);
  }
  assert.strictEqual(codeForThreat(null), CODE.SUSPICIOUS_ACTIVITY);
  assert.strictEqual(codeForThreat({}), CODE.SUSPICIOUS_ACTIVITY);
});

test("every threat type given its own code is one the agent actually reports", () => {
  const agent = fs.readFileSync(path.join(__dirname, "../agent.py"), "utf8");
  const reported = new Set([...agent.matchAll(/"type":\s*"([a-z_]+)"/g)].map((m) => m[1]));
  for (const type of [
    "ai_cheating_tool",
    "transparent_overlay",
    "renamed_blocked_app",
    "remote_session",
    "virtual_machine",
  ]) {
    assert.ok(reported.has(type), `agent.py no longer reports "${type}"`);
  }
});

test("only the ai blocklist category is ai_tool; the rest are blocked_app", () => {
  for (const category of CATEGORIES) {
    assert.strictEqual(
      codeForProcessCategory(category),
      category === "ai" ? CODE.AI_TOOL : CODE.BLOCKED_APP,
      category
    );
  }
});

test("the README documents every code for the interview site", () => {
  const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
  const section = readme.match(/## Web app integration[\s\S]*?(?=\n## )/);
  assert.ok(section, "could not locate the Web app integration section");
  for (const code of ALL) {
    assert.match(section[0], new RegExp(`\\|\\s*\`${code}\`\\s*\\|`), `${code} is undocumented`);
  }
});
