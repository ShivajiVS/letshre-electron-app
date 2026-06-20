"use strict";

/**
 * Tests for the blocked-process scanner — the core "is a banned app running"
 * check. execFile is stubbed so these run on any platform (the Windows tasklist
 * CSV parse is what ships and is exercised here).
 */

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("child_process");

const detectMirroring = require("../src/detector/mirrorDetector");
const { checkProcesses, invalidateProcessCache } = detectMirroring;

const _origExecFile = childProcess.execFile;

/** Make the next execFile call yield (err, stdout). */
function stubExecFile(err, stdout) {
  childProcess.execFile = (_bin, _args, cb) => cb(err, stdout);
}

test.after(() => {
  childProcess.execFile = _origExecFile;
});

const CSV_WITH_CHROME =
  '"chrome.exe","1234","Console","1","120,000 K"\r\n' +
  '"notepad.exe","2222","Console","1","8,000 K"\r\n';
const CSV_CLEAN = '"explorer.exe","1","Console","1","1 K"\r\n';

test("checkProcesses: flags a blocked app by exact image name", async () => {
  invalidateProcessCache();
  stubExecFile(null, CSV_WITH_CHROME);
  const { found, status } = await checkProcesses();
  assert.strictEqual(status, "clear");
  assert.ok(found.includes("chrome.exe"), "chrome.exe should be detected");
  assert.ok(!found.includes("notepad.exe"), "notepad.exe is not on the blocklist");
});

test("checkProcesses: no substring match (chromedriver !== chrome.exe)", async () => {
  invalidateProcessCache();
  stubExecFile(null, '"chromedriver.exe","1","Console","1","1 K"\r\n');
  const { found } = await checkProcesses();
  assert.ok(!found.includes("chrome.exe"), "chromedriver must not match chrome.exe");
});

test("checkProcesses: clean system returns empty found list", async () => {
  invalidateProcessCache();
  stubExecFile(null, CSV_CLEAN);
  const { found, status } = await checkProcesses();
  assert.strictEqual(status, "clear");
  assert.deepStrictEqual(found, []);
});

test("checkProcesses: fail-CLOSED indeterminate on probe error, not cached", async () => {
  invalidateProcessCache();
  stubExecFile(new Error("tasklist failed"), "");
  const r1 = await checkProcesses();
  assert.strictEqual(r1.status, "indeterminate");
  assert.deepStrictEqual(r1.found, []);

  // An indeterminate result must NOT be cached — the next call re-probes.
  stubExecFile(null, CSV_WITH_CHROME);
  const r2 = await checkProcesses();
  assert.strictEqual(r2.status, "clear");
  assert.ok(r2.found.includes("chrome.exe"));
});

test("checkProcesses: serves cache within TTL until invalidated", async () => {
  invalidateProcessCache();
  stubExecFile(null, CSV_WITH_CHROME);
  const a = await checkProcesses();
  assert.ok(a.found.includes("chrome.exe"));

  // Underlying data changes but we don't invalidate → cached result served.
  stubExecFile(null, CSV_CLEAN);
  const b = await checkProcesses();
  assert.ok(b.found.includes("chrome.exe"), "should still serve cached result");

  invalidateProcessCache();
  const c = await checkProcesses();
  assert.deepStrictEqual(c.found, [], "fresh probe after invalidation");
});

test("detectMirroring: violation + reason when a blocked app is running", async () => {
  invalidateProcessCache();
  stubExecFile(null, CSV_WITH_CHROME);
  const r = await detectMirroring();
  assert.strictEqual(r.detected, true);
  assert.strictEqual(r.status, "violation");
  assert.match(r.reason, /chrome/i);
});

test("detectMirroring: clear when nothing blocked is running", async () => {
  invalidateProcessCache();
  stubExecFile(null, CSV_CLEAN);
  const r = await detectMirroring();
  assert.strictEqual(r.detected, false);
  assert.strictEqual(r.status, "clear");
});

test("detectMirroring: propagates indeterminate from a failed scan", async () => {
  invalidateProcessCache();
  stubExecFile(new Error("boom"), "");
  const r = await detectMirroring();
  assert.strictEqual(r.status, "indeterminate");
  assert.strictEqual(r.detected, false);
});
