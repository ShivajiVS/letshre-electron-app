"use strict";

/**
 * Tests for the process-kill whitelist guard — the IPC-reachable kill must only
 * ever terminate blocklisted apps, never the app itself or arbitrary processes.
 * These cases reject BEFORE any spawn, so no real process is touched.
 */

const test = require("node:test");
const assert = require("node:assert");

const { killSingleProcess } = require("../src/main/processKiller");

test("rejects a process that is not on the blocklist", async () => {
  const r = await killSingleProcess("explorer.exe");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not in blocked list/i);
});

test("refuses to kill its own application", async () => {
  const r = await killSingleProcess("LetsHyre Secure Interview.exe");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /own process/i);
});

test("refuses to kill a version-suffixed copy of its own application", async () => {
  const r = await killSingleProcess("LetsHyre Secure Interview 1.1.5.exe");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /own process/i);
});

test("refuses to kill the bundled security agent", async () => {
  const r = await killSingleProcess("agent.exe");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /own process/i);
});
