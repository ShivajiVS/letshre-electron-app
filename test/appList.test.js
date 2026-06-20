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
