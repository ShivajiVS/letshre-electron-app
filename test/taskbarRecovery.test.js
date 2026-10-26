"use strict";

// An earlier run's agent died with the taskbar hidden: the next launch starts
// the agent to show it again, and stops it unless it is wanted.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { recoverHiddenTaskbar, restoreFilePath } = require("../src/main/taskbarRecovery");

function deps(overrides = {}) {
  const calls = { ready: 0, killed: 0 };
  return {
    calls,
    args: {
      platform: "win32",
      exists: () => true,
      whenAgentReady: async () => {
        calls.ready++;
        return true;
      },
      killAgent: () => {
        calls.killed++;
      },
      agentStillWanted: () => false,
      ...overrides,
    },
  };
}

test("the restore file is where agent.py writes it", () => {
  assert.strictEqual(
    restoreFilePath({ LOCALAPPDATA: "C:\\Users\\c\\AppData\\Local" }),
    path.join("C:\\Users\\c\\AppData\\Local", "letshyre-secure-interview", "taskbar-restore.json")
  );
  const agent = fs.readFileSync(path.join(__dirname, "..", "agent.py"), "utf8");
  assert.match(agent, /"taskbar-restore\.json"/);
  assert.match(agent, /"letshyre-secure-interview"/);
});

test("a left-over restore file starts the agent, which restores it, then stops it", async () => {
  const { calls, args } = deps();
  assert.strictEqual(await recoverHiddenTaskbar(args), true);
  assert.deepStrictEqual(calls, { ready: 1, killed: 1 });
});

test("the agent keeps running if the security check or interview now needs it", async () => {
  const { calls, args } = deps({ agentStillWanted: () => true });
  await recoverHiddenTaskbar(args);
  assert.deepStrictEqual(calls, { ready: 1, killed: 0 });
});

test("nothing happens without the file, or off Windows", async () => {
  for (const overrides of [{ exists: () => false }, { platform: "darwin" }]) {
    const { calls, args } = deps(overrides);
    assert.strictEqual(await recoverHiddenTaskbar(args), false);
    assert.deepStrictEqual(calls, { ready: 0, killed: 0 });
  }
});
