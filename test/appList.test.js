"use strict";

/**
 * Tests for the single source of truth of blocked apps + display names.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  getDisplayName,
  ALL_BLOCKED_APPS,
  MEETING_APPS,
  BROWSER_APPS,
  AI_CHEATING_APPS,
  APP_COMPANIONS,
  getCompanions,
} = require("../src/shared/appList");

test("getDisplayName maps a known process to its friendly name", () => {
  assert.strictEqual(getDisplayName("chrome.exe"), "Google Chrome");
  assert.strictEqual(getDisplayName("zoom.exe"), "Zoom");
});

test("getDisplayName falls back to the raw name when unknown", () => {
  assert.strictEqual(getDisplayName("totally-unknown.exe"), "totally-unknown.exe");
});

test("ALL_BLOCKED_APPS aggregates every category", () => {
  for (const app of [...MEETING_APPS, ...BROWSER_APPS, ...AI_CHEATING_APPS]) {
    assert.ok(ALL_BLOCKED_APPS.includes(app), `${app} should be in ALL_BLOCKED_APPS`);
  }
});

test("ALL_BLOCKED_APPS covers the key cheat vectors", () => {
  for (const app of ["zoom.exe", "chrome.exe", "obs64.exe", "pmodule.exe"]) {
    assert.ok(ALL_BLOCKED_APPS.includes(app), `${app} should be blocked`);
  }
});

test("blocklist entries are lowercase (matching is case-insensitive via .toLowerCase())", () => {
  for (const app of ALL_BLOCKED_APPS) {
    assert.strictEqual(app, app.toLowerCase(), `${app} should be lowercase`);
  }
});

// ─── Companion processes ─────────────────────────────────────────────────────

/** Every companion name in the map, flattened. */
const ALL_COMPANIONS = Object.values(APP_COMPANIONS).flat();

/**
 * Shared / system processes that other software depends on. Killing any of
 * these would damage the machine or take down unrelated apps, so they must
 * never appear as a companion. Lowercase, compared case-insensitively.
 */
const FORBIDDEN_SHARED_PROCESSES = [
  "msedgewebview2.exe",
  "runtimebroker.exe",
  "explorer.exe",
  "svchost.exe",
  "dllhost.exe",
  "applicationframehost.exe",
  "conhost.exe",
  "taskhostw.exe",
  "sihost.exe",
  "csrss.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "update.exe", // shared Squirrel updater used by many Electron vendors
  "updater.exe",
  "crashpad_handler.exe",
  "node.exe",
  "cmd.exe",
  "powershell.exe",
];

test("getCompanions returns known companions and is case-insensitive", () => {
  const lower = getCompanions("zoom.exe");
  assert.ok(lower.length > 0, "zoom.exe should have companions");
  assert.deepStrictEqual(getCompanions("ZOOM.EXE"), lower);
  assert.deepStrictEqual(getCompanions("Zoom.Exe"), lower);
});

test("getCompanions returns [] for unknown, empty, and non-string names", () => {
  for (const input of ["totally-unknown.exe", "", "constructor", "toString", null, undefined, 42]) {
    const result = getCompanions(input);
    assert.ok(Array.isArray(result), `getCompanions(${String(input)}) should return an array`);
    assert.strictEqual(result.length, 0, `getCompanions(${String(input)}) should be empty`);
  }
});

test("getCompanions returns a copy — callers cannot mutate the map", () => {
  const first = getCompanions("zoom.exe");
  first.push("bogus.exe");
  assert.ok(!getCompanions("zoom.exe").includes("bogus.exe"), "map should be unaffected");
});

test("every APP_COMPANIONS key is a real blocked app (no orphan keys)", () => {
  for (const key of Object.keys(APP_COMPANIONS)) {
    assert.ok(ALL_BLOCKED_APPS.includes(key), `${key} should be in ALL_BLOCKED_APPS`);
  }
});

test("companions are kill-only — none appear in the detection blocklist", () => {
  for (const companion of ALL_COMPANIONS) {
    assert.ok(
      !ALL_BLOCKED_APPS.includes(companion),
      `${companion} is a companion and must NOT be in ALL_BLOCKED_APPS`,
    );
  }
});

test("no companion is a shared/system process, unless it is path-scoped", () => {
  // Shared image names are banned as kill targets because terminating them
  // damages unrelated software. The ONE permitted exception is a name that is
  // pinned to its owning app's install directory — the companion-scope tests
  // below then prove every app listing it actually supplies that scope.
  const { requiresPathScope } = require("../src/shared/appList");
  for (const companion of ALL_COMPANIONS) {
    const name = companion.toLowerCase();
    if (!FORBIDDEN_SHARED_PROCESSES.includes(name)) { continue; }
    assert.ok(
      requiresPathScope(name),
      `${companion} is a shared/system process and must never be a kill target ` +
        `unless it is registered in APP_COMPANION_SCOPES`,
    );
  }
});

// ─── Path-scoped companions ──────────────────────────────────────────────────
// `update.exe` is Squirrel's relauncher and IS what brings Discord/Slack/classic
// Teams back after a kill — but every Squirrel app ships one under that same
// name. It is allowed as a kill target ONLY because it is pinned to its owning
// app's install directory. These tests encode that exception so it cannot be
// widened by accident into "kill every update.exe on the machine".

const {
  APP_COMPANION_SCOPES,
  getCompanionScope,
  requiresPathScope,
} = require("../src/shared/appList");

test("every scoped companion is declared as requiring a path scope", () => {
  for (const scopes of Object.values(APP_COMPANION_SCOPES)) {
    for (const companion of Object.keys(scopes)) {
      assert.ok(
        requiresPathScope(companion),
        `${companion} has a scope entry but requiresPathScope() does not report it`,
      );
    }
  }
});

test("every app listing a scope-requiring companion supplies a scope for it", () => {
  // This is the invariant that keeps the exception safe. A shared name listed as
  // a companion WITHOUT a scope would be killed by image name alone.
  for (const [app, companions] of Object.entries(APP_COMPANIONS)) {
    for (const companion of companions) {
      if (!requiresPathScope(companion)) { continue; }
      const scope = getCompanionScope(app, companion);
      assert.ok(
        scope && scope.length > 0,
        `${app} lists shared companion ${companion} with no path scope — it would be killed by name alone`,
      );
    }
  }
});

test("every APP_COMPANION_SCOPES key is a real blocked app, and lists that companion", () => {
  for (const [app, scopes] of Object.entries(APP_COMPANION_SCOPES)) {
    assert.ok(ALL_BLOCKED_APPS.includes(app), `${app} should be in ALL_BLOCKED_APPS`);
    for (const companion of Object.keys(scopes)) {
      assert.ok(
        (APP_COMPANIONS[app] || []).includes(companion),
        `${app} has a scope for ${companion} but does not list it as a companion (dead entry)`,
      );
    }
  }
});

test("getCompanionScope is case-insensitive and returns null when no scope applies", () => {
  assert.strictEqual(getCompanionScope("DISCORD.EXE", "UPDATE.EXE"), "\\discord\\");
  assert.strictEqual(getCompanionScope("discord.exe", "zoomlauncher.exe"), null);
  assert.strictEqual(getCompanionScope("zoom.exe", "update.exe"), null);
  assert.strictEqual(getCompanionScope("unknown.exe", "update.exe"), null);
});

test("scopes are vendor-distinct — one app's scope never matches another's path", () => {
  const discord = getCompanionScope("discord.exe", "update.exe");
  const slack = getCompanionScope("slack.exe", "update.exe");
  assert.notStrictEqual(discord, slack);
  assert.ok(!`c:\\users\\x\\appdata\\local\\slack\\update.exe`.includes(discord));
  assert.ok(!`c:\\users\\x\\appdata\\local\\discord\\update.exe`.includes(slack));
});

test("no companion targets our own app or agent", () => {
  for (const companion of ALL_COMPANIONS) {
    assert.ok(!/letshyre/i.test(companion), `${companion} must not match our own app`);
    assert.notStrictEqual(companion.toLowerCase(), "electron.exe");
    assert.notStrictEqual(companion.toLowerCase(), "agent.exe");
  }
});

test("companion names are lowercase, non-empty strings", () => {
  for (const [key, companions] of Object.entries(APP_COMPANIONS)) {
    assert.strictEqual(key, key.toLowerCase(), `key ${key} should be lowercase`);
    assert.ok(Array.isArray(companions), `${key} should map to an array`);
    for (const companion of companions) {
      assert.strictEqual(typeof companion, "string", `${key}: companion should be a string`);
      assert.ok(companion.trim().length > 0, `${key}: companion should be non-empty`);
      assert.strictEqual(companion, companion.toLowerCase(), `${companion} should be lowercase`);
    }
  }
});

test("companion lists contain no duplicates, within or across apps", () => {
  for (const [key, companions] of Object.entries(APP_COMPANIONS)) {
    assert.strictEqual(
      new Set(companions).size,
      companions.length,
      `${key} has duplicate companions`,
    );
    assert.ok(!companions.includes(key), `${key} should not list itself as a companion`);
  }
});
