"use strict";

/**
 * Tests for the process-kill engine.
 *
 * Two layers are covered:
 *   1. The IPC-reachable whitelist / self-protection guards — the kill must only
 *      ever terminate blocklisted apps (or the companions of the app being
 *      closed), never the app itself or arbitrary processes.
 *   2. The decision logic behind PID-accurate termination: process-table
 *      parsing, the self-exclusion PID set, companion-before-main ordering and
 *      outcome classification.
 *
 * NO REAL PROCESS IS EVER SPAWNED OR KILLED HERE. The guard cases reject before
 * any spawn; every end-to-end case runs killSingleProcess() against injected
 * fake enumeration/kill dependencies.
 */

const test = require("node:test");
const assert = require("node:assert");

const { killSingleProcess, killAllProcesses, isOwnProcess, _internal } = require("../src/main/processKiller");

const {
  parseCsvLine,
  parseCreated,
  parseWindowsProcessCsv,
  parseUnixProcessTable,
  matchesImageName,
  computeExclusionPids,
  planKillLevels,
  planTargetNames,
  isKillableName,
  classifyPidKill,
  classifyKillOutcome,
} = _internal;

// ─── Fixtures / helpers ──────────────────────────────────────────────────────

const BLOCKED = ["chrome.exe", "zoom.exe", "teams.exe"];
const COMPANIONS = { "zoom.exe": ["zoomlauncher.exe", "cpthost.exe"] };

/** Instant timings so the injected runs finish immediately (no real waiting). */
const FAST_TIMING = {
  enumTimeoutMs: 1,
  verifyTimeoutMs: 1,
  verifyPollMs: 1,
  relaunchWatchMs: 1,
  relaunchPollMs: 1,
};

function proc(pid, ppid, name, extra) {
  return { pid, ppid, name, created: 100, ...(extra || {}) };
}

/** Builds an injected dependency set. Nothing here touches the OS. */
function fakeDeps(overrides) {
  return {
    platform: "win32",
    selfPid: 1000,
    timing: FAST_TIMING,
    sleep: async () => {},
    isBlocked: (n) => BLOCKED.includes(n),
    getCompanions: (n) => COMPANIONS[n] || [],
    listProcessTable: async () => ({ ok: true, procs: [proc(1000, 900, "electron.exe")] }),
    findPidsByName: async () => ({ ok: true, pids: [] }),
    killPid: async () => ({ status: "killed" }),
    ...(overrides || {}),
  };
}

/** findPidsByName stub driven by a scripted sequence of "is it alive" answers. */
function scriptedPresence(sequence) {
  let i = 0;
  return async () => {
    const alive = sequence[Math.min(i++, sequence.length - 1)];
    return { ok: true, pids: alive ? [4242] : [] };
  };
}

// ─── 1. Whitelist / self-protection guards (pre-existing behaviour) ──────────

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

test("guard rejections carry structured outcomes", async () => {
  assert.strictEqual((await killSingleProcess("explorer.exe")).outcome, "not-blocked");
  assert.strictEqual((await killSingleProcess("agent.exe")).outcome, "own-process");
});

test("unsupported platforms fail rather than guessing", async () => {
  const r = await killSingleProcess("chrome.exe", fakeDeps({ platform: "linux" }));
  assert.strictEqual(r.outcome, "unsupported");
  assert.strictEqual(r.success, false);
});

// ─── 2. Windows CSV parsing ──────────────────────────────────────────────────

test("parseCsvLine handles quoted fields, embedded commas and doubled quotes", () => {
  assert.deepStrictEqual(parseCsvLine('"a,b",12,"say ""hi"""'), ["a,b", "12", 'say "hi"']);
  assert.deepStrictEqual(parseCsvLine("plain,2,"), ["plain", "2", ""]);
});

test("parseWindowsProcessCsv reads PowerShell Get-CimInstance output", () => {
  const csv = [
    "#TYPE Selected.Microsoft.Management.Infrastructure.CimInstance",
    '"Name","ProcessId","ParentProcessId","Created"',
    '"chrome.exe","4242","1500","638000000000000000"',
    '"Weird, Name.exe","77","1"," "',
  ].join("\r\n");

  const procs = parseWindowsProcessCsv(csv);
  assert.strictEqual(procs.length, 2);
  assert.deepStrictEqual(procs[0], { pid: 4242, ppid: 1500, name: "chrome.exe", created: 638000000000000000 });
  assert.strictEqual(procs[1].name, "Weird, Name.exe");
  assert.ok(Number.isNaN(procs[1].created));
});

test("parseWindowsProcessCsv reads the wmic CSV fallback shape (Node column first)", () => {
  const csv = [
    "",
    "Node,CreationDate,Name,ParentProcessId,ProcessId",
    "DESKTOP-1,20260815181828.123456+330,zoom.exe,900,4321",
    "",
  ].join("\r\n");

  const procs = parseWindowsProcessCsv(csv);
  assert.deepStrictEqual(procs, [{ pid: 4321, ppid: 900, name: "zoom.exe", created: 20260815181828 }]);
});

test("parseWindowsProcessCsv tolerates blank lines, short rows and junk PIDs", () => {
  const csv = [
    '"Name","ProcessId","ParentProcessId"',
    "",
    '"broken.exe"',            // missing PID entirely
    '"bad.exe","N/A","4"',     // non-numeric PID
    '"ok.exe","5"',            // missing PPID
    "   ",
  ].join("\n");

  const procs = parseWindowsProcessCsv(csv);
  assert.deepStrictEqual(procs, [{ pid: 5, ppid: null, name: "ok.exe", created: NaN }]);
});

test("parseWindowsProcessCsv returns nothing when no header row is present", () => {
  assert.deepStrictEqual(parseWindowsProcessCsv('"chrome.exe","4242"'), []);
  assert.deepStrictEqual(parseWindowsProcessCsv(""), []);
  assert.deepStrictEqual(parseWindowsProcessCsv(undefined), []);
});

test("parseCreated accepts ticks and WMI datetime, rejects anything else", () => {
  assert.strictEqual(parseCreated("638000000000000000"), 638000000000000000);
  assert.strictEqual(parseCreated("20260815181828.123456+330"), 20260815181828);
  assert.ok(Number.isNaN(parseCreated("not a date")));
  assert.ok(Number.isNaN(parseCreated("")));
});

// ─── 3. macOS ps parsing ─────────────────────────────────────────────────────

test("parseUnixProcessTable keeps full command paths containing spaces", () => {
  const out = [
    "    1     0 /sbin/launchd",
    "  512     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "",
    "garbage line without pids",
    "  777   512 /usr/bin/helper",
  ].join("\n");

  const procs = parseUnixProcessTable(out);
  assert.strictEqual(procs.length, 3);
  assert.strictEqual(procs[1].pid, 512);
  assert.strictEqual(procs[1].ppid, 1);
  assert.strictEqual(procs[1].name, "Google Chrome");
  assert.strictEqual(procs[1].command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("matchesImageName: Windows is an exact image-name match", () => {
  assert.ok(matchesImageName(proc(1, 0, "chrome.exe"), "chrome.exe", "win32"));
  assert.ok(!matchesImageName(proc(1, 0, "chromedriver.exe"), "chrome.exe", "win32"));
  assert.ok(!matchesImageName(proc(1, 0, "chrome.exe"), "", "win32"));
});

test("matchesImageName: macOS matches the bundle path or the executable basename", () => {
  const chrome = {
    pid: 1, ppid: 1, name: "Google Chrome",
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  };
  assert.ok(matchesImageName(chrome, "google chrome.app", "darwin"));
  assert.ok(matchesImageName(chrome, "Google Chrome", "darwin"));
  assert.ok(!matchesImageName(chrome, "firefox.app", "darwin"));

  // A bare (non-bundle) blocklist entry such as "scrcpy" still matches.
  assert.ok(matchesImageName({ pid: 2, ppid: 1, name: "scrcpy", command: "/usr/local/bin/scrcpy" }, "scrcpy", "darwin"));
});

// ─── 4. Self-exclusion PID set (the safety invariant) ────────────────────────

test("computeExclusionPids protects our own PID, ancestors and descendants", () => {
  const procs = [
    proc(4, 0, "System"),
    proc(800, 4, "explorer.exe"),        // ancestor
    proc(1000, 800, "electron.exe"),     // us
    proc(1100, 1000, "electron.exe"),    // our renderer child
    proc(1200, 1100, "conhost.exe"),     // grandchild
    proc(2000, 800, "chrome.exe"),       // sibling — killable
  ];
  const excluded = computeExclusionPids(procs, 1000, "win32");

  for (const pid of [0, 4, 800, 1000, 1100, 1200]) {
    assert.ok(excluded.has(pid), `expected PID ${pid} to be protected`);
  }
  assert.ok(!excluded.has(2000), "a sibling blocked app must remain killable");
});

test("computeExclusionPids protects a detached security agent and its children", () => {
  const procs = [
    proc(1000, 500, "electron.exe"),
    proc(3000, 1, "agent.exe"),       // spawned detached — not in our tree
    proc(3001, 3000, "python.exe"),   // agent's child
    proc(4000, 1, "zoom.exe"),
  ];
  const excluded = computeExclusionPids(procs, 1000, "win32");
  assert.ok(excluded.has(3000));
  assert.ok(excluded.has(3001));
  assert.ok(!excluded.has(4000));
});

test("computeExclusionPids does not expand the subtree of ancestors or of PID 1", () => {
  // On macOS launchd (PID 1) parents every GUI app; expanding it would protect
  // every application we are asked to close.
  const procs = [
    proc(1, 0, "launchd"),
    proc(1000, 1, "LetsHyre Secure Interview"),
    proc(2000, 1, "Google Chrome", { command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
  ];
  const excluded = computeExclusionPids(procs, 1000, "darwin");
  assert.ok(excluded.has(1));
  assert.ok(excluded.has(1000));
  assert.ok(!excluded.has(2000), "sibling apps under launchd must stay killable");
});

test("computeExclusionPids ignores a recycled parent PID that is newer than its child", () => {
  // Windows keeps a dead parent's PID; a blocked app reusing it must not be
  // mistaken for our ancestor.
  const procs = [
    { pid: 900, ppid: 4, name: "chrome.exe", created: 500 },  // started AFTER us
    { pid: 1000, ppid: 900, name: "electron.exe", created: 100 },
  ];
  const excluded = computeExclusionPids(procs, 1000, "win32");
  assert.ok(excluded.has(1000));
  assert.ok(!excluded.has(900), "an implausibly newer 'parent' must not be protected");
});

test("computeExclusionPids survives a cyclic parent chain", () => {
  const procs = [proc(10, 11, "a.exe"), proc(11, 10, "b.exe"), proc(1000, 10, "electron.exe")];
  const excluded = computeExclusionPids(procs, 1000, "win32");
  assert.ok(excluded.has(1000));
});

test("computeExclusionPids still protects our own PID with an empty/garbage table", () => {
  assert.ok(computeExclusionPids([], 1000, "win32").has(1000));
  assert.ok(computeExclusionPids(null, 1000, "win32").has(1000));
});

// ─── 5. Ordering ─────────────────────────────────────────────────────────────

test("planKillLevels returns deepest children before their parents", () => {
  const table = [proc(100, 4, "chrome.exe"), proc(200, 100, "chrome.exe"), proc(300, 200, "chrome.exe")];
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const levels = planKillLevels(table, byPid);
  assert.deepStrictEqual(levels, [[300], [200], [100]]);
});

test("planTargetNames puts companions before the main executable", () => {
  assert.deepStrictEqual(
    planTargetNames("zoom.exe", () => ["ZoomLauncher.exe", "cpthost.exe"]),
    ["zoomlauncher.exe", "cpthost.exe", "zoom.exe"],
  );
});

test("planTargetNames tolerates a missing/throwing companion source", () => {
  assert.deepStrictEqual(planTargetNames("zoom.exe", () => []), ["zoom.exe"]);
  assert.deepStrictEqual(planTargetNames("zoom.exe", () => undefined), ["zoom.exe"]);
  assert.deepStrictEqual(planTargetNames("zoom.exe", () => { throw new Error("boom"); }), ["zoom.exe"]);
});

test("planTargetNames de-duplicates and never lists our own processes", () => {
  const names = planTargetNames("zoom.exe", () => ["zoomlauncher.exe", "ZOOMLAUNCHER.EXE", "zoom.exe", "agent.exe"]);
  assert.deepStrictEqual(names, ["zoomlauncher.exe", "zoom.exe"]);
});

test("isKillableName: blocklisted apps and the target's OWN companions only", () => {
  const blocked = (n) => BLOCKED.includes(n);
  const companions = (n) => COMPANIONS[n] || [];

  assert.ok(isKillableName("chrome.exe", "chrome.exe", blocked, companions), "blocklisted app is killable");
  assert.ok(isKillableName("zoomlauncher.exe", "zoom.exe", blocked, companions), "companion of the target is killable");
  assert.ok(!isKillableName("zoomlauncher.exe", "chrome.exe", blocked, companions), "companion of a different app is rejected");
  assert.ok(!isKillableName("explorer.exe", "zoom.exe", blocked, companions), "unrelated process is rejected");
  assert.ok(!isKillableName("agent.exe", "zoom.exe", () => true, companions), "own process is never killable");
});

// ─── 6. Outcome classification ───────────────────────────────────────────────

test("classifyPidKill maps every exit-code / stderr combination", () => {
  assert.strictEqual(classifyPidKill({ code: 0 }).status, "killed");
  assert.strictEqual(classifyPidKill({ code: 128 }).status, "gone");
  assert.strictEqual(classifyPidKill({ code: 1, stderr: "ERROR: The process \"x\" not found." }).status, "gone");
  assert.strictEqual(classifyPidKill({ code: 1, stderr: "kill: 42: No such process" }).status, "gone");
  assert.strictEqual(classifyPidKill({ code: 1, stderr: "Reason: Access is denied." }).status, "denied");
  assert.strictEqual(classifyPidKill({ code: 1, stderr: "kill: 42: Operation not permitted" }).status, "denied");
  assert.strictEqual(classifyPidKill({ code: 1, stderr: "something else" }).status, "error");
  assert.strictEqual(classifyPidKill({ code: null, error: "spawn ENOENT" }).status, "error");
  assert.strictEqual(classifyPidKill(null).status, "error");
});

test("classifyKillOutcome derives each outcome from measured signals", () => {
  const base = { found: 3, killable: 3, killed: 3, denied: 0, spawnErrors: 0, cleared: true, respawned: false };

  assert.strictEqual(classifyKillOutcome({ ...base, found: 0 }), "already-gone");
  assert.strictEqual(classifyKillOutcome({ ...base, killable: 0 }), "still-running");
  assert.strictEqual(classifyKillOutcome(base), "closed");
  assert.strictEqual(classifyKillOutcome({ ...base, respawned: true }), "respawned");
  assert.strictEqual(
    classifyKillOutcome({ ...base, cleared: false, killed: 0, denied: 2 }), "access-denied",
  );
  assert.strictEqual(
    classifyKillOutcome({ ...base, cleared: false, killed: 0, spawnErrors: 2 }), "spawn-error",
  );
  assert.strictEqual(classifyKillOutcome({ ...base, cleared: false }), "still-running");
  // Access-denied outranks a generic failure, but a confirmed clear outranks both.
  assert.strictEqual(classifyKillOutcome({ ...base, denied: 1, cleared: true }), "closed");
  assert.strictEqual(classifyKillOutcome({}), "already-gone");
});

// ─── 7. End-to-end with injected fakes (no real processes) ──────────────────

test("reports already-gone when the app is not running", async () => {
  let killCalls = 0;
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    killPid: async () => { killCalls++; return { status: "killed" }; },
  }));
  assert.strictEqual(r.outcome, "already-gone");
  assert.strictEqual(r.success, true);
  assert.strictEqual(killCalls, 0);
});

test("reports closed when every target PID is confirmed gone", async () => {
  const killed = [];
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [proc(1000, 900, "electron.exe"), proc(2000, 900, "chrome.exe"), proc(2001, 2000, "chrome.exe")],
    }),
    killPid: async (pid) => { killed.push(pid); return { status: "killed" }; },
    findPidsByName: async () => ({ ok: true, pids: [] }),
  }));

  assert.strictEqual(r.outcome, "closed");
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.pidsKilled, 2);
  assert.deepStrictEqual(killed, [2001, 2000], "child PID must be killed before its parent");
  assert.strictEqual(r.error, undefined);
});

test("reports respawned when the app comes back after a verified kill", async () => {
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({ ok: true, procs: [proc(2000, 900, "chrome.exe")] }),
    // gone at verification, back during the relaunch watch
    findPidsByName: scriptedPresence([false, true]),
  }));

  assert.strictEqual(r.outcome, "respawned");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /reappeared/i);
});

test("reports access-denied when the OS refuses termination", async () => {
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({ ok: true, procs: [proc(2000, 900, "chrome.exe")] }),
    killPid: async () => ({ status: "denied", detail: "Access is denied." }),
    findPidsByName: scriptedPresence([true]),
  }));

  assert.strictEqual(r.outcome, "access-denied");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /denied/i);
});

test("reports still-running when the kill succeeded but the app survives", async () => {
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({ ok: true, procs: [proc(2000, 900, "chrome.exe")] }),
    findPidsByName: scriptedPresence([true]),
  }));
  assert.strictEqual(r.outcome, "still-running");
  assert.strictEqual(r.success, false);
});

test("an unverifiable presence check never reports success", async () => {
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({ ok: true, procs: [proc(2000, 900, "chrome.exe")] }),
    findPidsByName: async () => ({ ok: false, pids: [], error: "tasklist failed" }),
  }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.outcome, "still-running");
});

test("fails closed when the process table cannot be read", async () => {
  let killCalls = 0;
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({ ok: false, procs: [], error: "powershell blocked by policy" }),
    killPid: async () => { killCalls++; return { status: "killed" }; },
  }));

  assert.strictEqual(r.outcome, "spawn-error");
  assert.strictEqual(r.success, false);
  assert.match(r.error, /powershell blocked/i);
  assert.strictEqual(killCalls, 0, "must not kill anything with an unknown exclusion set");
});

// ─── 8. PID-level self-protection, end to end ───────────────────────────────

test("never terminates a matching PID that is inside our own process tree", async () => {
  const killed = [];
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [
        proc(900, 4, "explorer.exe"),
        proc(1000, 900, "electron.exe"),   // us
        proc(1500, 1000, "chrome.exe"),    // OUR child, e.g. an embedded helper
        proc(2000, 900, "chrome.exe"),     // the candidate's browser — killable
      ],
    }),
    killPid: async (pid) => { killed.push(pid); return { status: "killed" }; },
    findPidsByName: scriptedPresence([true]),
  }));

  assert.deepStrictEqual(killed, [2000], "the PID inside our own tree must be spared");
  assert.strictEqual(r.pidsKilled, 1);
});

test("refuses entirely when every matching PID belongs to our own tree", async () => {
  let killCalls = 0;
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [proc(1000, 900, "electron.exe"), proc(1500, 1000, "chrome.exe")],
    }),
    killPid: async () => { killCalls++; return { status: "killed" }; },
  }));

  assert.strictEqual(killCalls, 0);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.outcome, "still-running");
  assert.match(r.error, /protected/i);
});

// ─── 9. Companion-first behaviour, end to end ───────────────────────────────

test("kills companions before the main executable and reports which died", async () => {
  const order = [];
  const r = await killSingleProcess("zoom.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [
        proc(1000, 900, "electron.exe"),
        proc(3000, 900, "zoom.exe"),
        proc(3100, 900, "zoomlauncher.exe"),
        proc(3200, 900, "cpthost.exe"),
      ],
    }),
    killPid: async (pid) => { order.push(pid); return { status: "killed" }; },
    findPidsByName: async () => ({ ok: true, pids: [] }),
  }));

  assert.deepStrictEqual(order, [3100, 3200, 3000], "launcher and helper must die before zoom.exe");
  assert.deepStrictEqual(r.companionsKilled, ["zoomlauncher.exe", "cpthost.exe"]);
  assert.strictEqual(r.outcome, "closed");
});

test("does not touch a companion belonging to a different app", async () => {
  const order = [];
  const r = await killSingleProcess("chrome.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [proc(2000, 900, "chrome.exe"), proc(3100, 900, "zoomlauncher.exe")],
    }),
    killPid: async (pid) => { order.push(pid); return { status: "killed" }; },
    findPidsByName: async () => ({ ok: true, pids: [] }),
  }));

  assert.deepStrictEqual(order, [2000], "zoom's launcher is not a companion of chrome");
  assert.deepStrictEqual(r.companionsKilled, []);
});

test("a companion with no running instance is simply skipped", async () => {
  const r = await killSingleProcess("zoom.exe", fakeDeps({
    listProcessTable: async () => ({ ok: true, procs: [proc(3000, 900, "zoom.exe")] }),
    findPidsByName: async () => ({ ok: true, pids: [] }),
  }));
  assert.strictEqual(r.outcome, "closed");
  assert.deepStrictEqual(r.companionsKilled, []);
});

test("a surviving companion keeps the result unsuccessful", async () => {
  const r = await killSingleProcess("zoom.exe", fakeDeps({
    listProcessTable: async () => ({
      ok: true,
      procs: [proc(3000, 900, "zoom.exe"), proc(3100, 900, "zoomlauncher.exe")],
    }),
    // zoom.exe is gone but the launcher is still listed
    findPidsByName: async (name) => ({ ok: true, pids: name === "zoomlauncher.exe" ? [3100] : [] }),
  }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.outcome, "still-running");
});

// ─── 10. Batch API ───────────────────────────────────────────────────────────

test("killAllProcesses returns results aligned with its input", async () => {
  const results = await killAllProcesses(["chrome.exe", "explorer.exe", "agent.exe"], fakeDeps());
  assert.strictEqual(results.length, 3);
  assert.deepStrictEqual(results.map((r) => r.processName), ["chrome.exe", "explorer.exe", "agent.exe"]);
  assert.deepStrictEqual(results.map((r) => r.outcome), ["already-gone", "not-blocked", "own-process"]);
});

test("killAllProcesses tolerates a non-array argument", async () => {
  assert.deepStrictEqual(await killAllProcesses(undefined), []);
  assert.deepStrictEqual(await killAllProcesses(null), []);
});

test("isOwnProcess is exported and case-insensitive", () => {
  assert.ok(isOwnProcess("ELECTRON.EXE"));
  assert.ok(isOwnProcess("LetsHyre Secure Interview 2.0.0.exe"));
  assert.ok(!isOwnProcess("chrome.exe"));
  assert.ok(!isOwnProcess(""));
});
