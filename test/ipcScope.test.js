"use strict";

/**
 * Tests for the IPC trust boundary (A3): the remote interview origin shares
 * one BrowserWindow/preload with the local file:// pages, so every ipcMain
 * channel must declare who is allowed to call it.
 *
 * Two halves:
 *  1. Pure-function tests of ipcScope's origin/frame predicates — no
 *     ipcMain/BrowserWindow involved, so these run under plain `node --test`
 *     the same way require("electron") resolves to a binary-path string here
 *     rather than the real API (see preflightVerdict.test.js/processKiller.test.js).
 *  2. Source-introspection tests (style borrowed from localeKeyUsage.test.js)
 *     that read ipcHandlers.js as text and assert every ipcMain registration
 *     went through registerHandler()/registerSend() with a valid, and
 *     correctly-chosen, scope. This is what catches a future handler added
 *     with a raw ipcMain.handle()/ipcMain.on() call that bypasses the scope
 *     check entirely.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  SCOPE,
  INTERVIEW_ORIGIN,
  LOCAL_ORIGINS,
  isOriginAllowed,
  isTopFrame,
  isFrameAllowed,
  isUrlOriginAllowed,
  registerHandler,
  registerSend,
} = require("../src/main/ipcScope");

const LOCAL_ORIGIN = "null";

// ─── Pure predicate tests ──────────────────────────────────────────────────

test("LOCAL_ORIGINS covers both Chromium's documented opaque origin and the string this app's installed Electron actually reports for loadFile() pages", () => {
  assert.strictEqual(LOCAL_ORIGINS.has("null"), true);
  assert.strictEqual(LOCAL_ORIGINS.has("file://"), true);
  assert.strictEqual(LOCAL_ORIGINS.has(INTERVIEW_ORIGIN), false);
});

test("INTERVIEW_ORIGIN is derived from INTERVIEW_BASE_URL, not hardcoded", () => {
  const { INTERVIEW_BASE_URL } = require("../src/shared/constants");
  assert.strictEqual(INTERVIEW_ORIGIN, new URL(INTERVIEW_BASE_URL).origin);
});

test("isOriginAllowed: local scope accepts only the file:// opaque origin", () => {
  assert.strictEqual(isOriginAllowed(SCOPE.LOCAL, "null"), true);
  assert.strictEqual(isOriginAllowed(SCOPE.LOCAL, INTERVIEW_ORIGIN), false);
  assert.strictEqual(isOriginAllowed(SCOPE.LOCAL, "https://evil.example"), false);
});

test("isOriginAllowed: interview scope accepts only INTERVIEW_ORIGIN", () => {
  assert.strictEqual(isOriginAllowed(SCOPE.INTERVIEW, INTERVIEW_ORIGIN), true);
  assert.strictEqual(isOriginAllowed(SCOPE.INTERVIEW, "null"), false);
  assert.strictEqual(isOriginAllowed(SCOPE.INTERVIEW, "https://evil.example"), false);
});

test("isOriginAllowed: an unknown scope throws rather than defaulting open", () => {
  assert.throws(() => isOriginAllowed("nonsense", INTERVIEW_ORIGIN));
});

test("isTopFrame: a frame that is its own top, or has a nullish top, is top-level", () => {
  const top = { origin: LOCAL_ORIGIN };
  top.top = top;
  assert.strictEqual(isTopFrame(top), true);
  assert.strictEqual(isTopFrame({ origin: LOCAL_ORIGIN, top: null }), true);
  assert.strictEqual(isTopFrame({ origin: LOCAL_ORIGIN }), true); // top undefined
});

test("isTopFrame: a frame whose top is a different frame is nested", () => {
  const top = { origin: INTERVIEW_ORIGIN };
  const child = { origin: INTERVIEW_ORIGIN, top };
  assert.strictEqual(isTopFrame(child), false);
});

test("isFrameAllowed: local scope passes a top-level file:// frame", () => {
  const frame = { origin: LOCAL_ORIGIN, top: null };
  assert.strictEqual(isFrameAllowed(SCOPE.LOCAL, frame), true);
});

test("isFrameAllowed: local scope also passes the origin this app's Electron build actually reports for file:// (not just the RFC 6454 opaque form)", () => {
  const frame = { origin: "file://", top: null };
  assert.strictEqual(isFrameAllowed(SCOPE.LOCAL, frame), true);
});

test("isFrameAllowed: local scope refuses a top-level interview-origin frame", () => {
  const frame = { origin: INTERVIEW_ORIGIN, top: null };
  assert.strictEqual(isFrameAllowed(SCOPE.LOCAL, frame), false);
});

test("isFrameAllowed: interview scope passes a top-level interview-origin frame", () => {
  const frame = { origin: INTERVIEW_ORIGIN, top: null };
  assert.strictEqual(isFrameAllowed(SCOPE.INTERVIEW, frame), true);
});

test("isFrameAllowed: interview scope refuses a top-level file:// frame", () => {
  const frame = { origin: LOCAL_ORIGIN, top: null };
  assert.strictEqual(isFrameAllowed(SCOPE.INTERVIEW, frame), false);
});

test("isFrameAllowed: a nested iframe on the interview origin is refused (top-frame only)", () => {
  const top = { origin: INTERVIEW_ORIGIN };
  const child = { origin: INTERVIEW_ORIGIN, top };
  assert.strictEqual(isFrameAllowed(SCOPE.INTERVIEW, child), false);
});

test("isFrameAllowed: a missing frame (no senderFrame) is refused, never allowed by default", () => {
  assert.strictEqual(isFrameAllowed(SCOPE.LOCAL, null), false);
  assert.strictEqual(isFrameAllowed(SCOPE.LOCAL, undefined), false);
  assert.strictEqual(isFrameAllowed(SCOPE.INTERVIEW, {}), false);
});

test("isUrlOriginAllowed: matches isOriginAllowed via URL parsing, including file://", () => {
  assert.strictEqual(isUrlOriginAllowed(SCOPE.LOCAL, "file:///C:/app/permissions.html"), true);
  assert.strictEqual(
    isUrlOriginAllowed(SCOPE.INTERVIEW, `${INTERVIEW_ORIGIN}/session?ac=1`),
    true
  );
  assert.strictEqual(isUrlOriginAllowed(SCOPE.INTERVIEW, "file:///C:/app/permissions.html"), false);
  assert.strictEqual(isUrlOriginAllowed(SCOPE.LOCAL, "not a url"), false);
});

test("registerHandler/registerSend: a missing or mistyped scope throws at registration time", () => {
  assert.throws(() => registerHandler("some-channel", undefined, () => {}));
  assert.throws(() => registerHandler("some-channel", "locale", () => {})); // typo, not "local"
  assert.throws(() => registerSend("some-channel", undefined, () => {}));
  assert.throws(() => registerSend("some-channel", "Local", () => {})); // wrong case
});

// ─── Source-introspection tests ────────────────────────────────────────────
// require("electron") resolves to a binary-path string under plain Node, so
// ipcHandlers.js can't be require()'d directly here (registerHandler() would
// dereference ipcMain.handle on that string the moment a valid scope reaches
// it). Read it as text instead, the same technique localeKeyUsage.test.js
// uses to cross-check i18n keys against source.

const IPC_HANDLERS_PATH = path.join(__dirname, "..", "src", "main", "ipcHandlers.js");
const ipcHandlersText = fs.readFileSync(IPC_HANDLERS_PATH, "utf8");

const CONSTANTS_PATH = path.join(__dirname, "..", "src", "shared", "constants.js");
const { IPC } = require(CONSTANTS_PATH);

test("ipcHandlers.js never calls ipcMain.handle()/ipcMain.on() directly", () => {
  // Every real ipcMain registration must go through registerHandler()/
  // registerSend() so scope can't be skipped. A raw call here is exactly the
  // bypass this whole mechanism exists to prevent.
  const rawCalls = ipcHandlersText.match(/\bipcMain\.(handle|on)\(/g) || [];
  assert.deepStrictEqual(rawCalls, [], "found raw ipcMain.handle()/ipcMain.on() call(s) in ipcHandlers.js");
});

/**
 * Extracts every registerHandler(IPC.X, SCOPE.Y, ...) / registerSend(IPC.X,
 * SCOPE.Y, ...) call from ipcHandlers.js: [{ channelKey, scope }].
 */
function extractRegistrations(text) {
  const re = /register(?:Handler|Send)\(\s*IPC\.([A-Z0-9_]+)\s*,\s*SCOPE\.([A-Z]+)\s*,/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ channelKey: m[1], scope: m[2] });
  }
  return out;
}

const registrations = extractRegistrations(ipcHandlersText);

test("every registerHandler()/registerSend() call in ipcHandlers.js uses a valid scope token", () => {
  const badScopes = registrations.filter((r) => r.scope !== "LOCAL" && r.scope !== "INTERVIEW");
  assert.deepStrictEqual(
    badScopes,
    [],
    `registrations with an unrecognised scope token: ${JSON.stringify(badScopes)}`
  );
});

test("every registered channel key refers to a real IPC constant (catches typos)", () => {
  const unknown = registrations.filter((r) => !(r.channelKey in IPC));
  assert.deepStrictEqual(unknown, [], `unknown IPC.* keys referenced: ${JSON.stringify(unknown)}`);
});

test("no channel is registered twice with two different scopes", () => {
  const byChannel = new Map();
  for (const { channelKey, scope } of registrations) {
    if (byChannel.has(channelKey) && byChannel.get(channelKey) !== scope) {
      assert.fail(`"${channelKey}" registered with conflicting scopes`);
    }
    byChannel.set(channelKey, scope);
  }
});

// The documented web-app contract (README "Web app integration (the
// contract)" + "Renderer API" tables): everything the interview site is
// meant to invoke directly. Everything else registered in ipcHandlers.js
// must be "local" — this is the actual classification decision under test,
// not just a syntax check.
const EXPECTED_INTERVIEW_SCOPE_CHANNELS = [
  "ACK_VIOLATION", // acknowledgeViolation() — contract step 2
  "INTERVIEW_COMPLETE", // interviewComplete(reason) — contract step 3
  "PROCTORING_START", // interview.letshyre.com → start recording
  "PROCTORING_STOP", // interview.letshyre.com → stop recording
];

test("exactly the documented contract channels are scoped \"interview\" — everything else is local", () => {
  const interviewScoped = registrations
    .filter((r) => r.scope === "INTERVIEW")
    .map((r) => r.channelKey)
    .sort();
  assert.deepStrictEqual(interviewScoped, [...EXPECTED_INTERVIEW_SCOPE_CHANNELS].sort());
});

test("every channel actually exposed to the renderer via preload.js's ALLOWED_* lists is registered with some scope", () => {
  // Cross-check against preload.js's own whitelist so a channel exposed to
  // the renderer can never silently skip scope enforcement on the main-process
  // side. RECORDER_* channels are intentionally excluded — they belong to a
  // separate hidden BrowserWindow/preload pair (preload-recorder.js) that
  // never loads the interview origin, and are registered by
  // screenRecorder.js, not ipcHandlers.js.
  const PRELOAD_PATH = path.join(__dirname, "..", "preload.js");
  const preloadText = fs.readFileSync(PRELOAD_PATH, "utf8");
  const registeredKeys = new Set(registrations.map((r) => r.channelKey));

  const exposedKeys = Object.keys(IPC).filter((key) => {
    if (key.startsWith("RECORDER_")) {
      return false;
    }
    if (key.startsWith("PUSH_") || key === "LOCALE_CHANGED" || key === "PREFLIGHT_PROGRESS") {
      return false; // main → renderer pushes, not ipcMain registrations
    }
    const channelValue = IPC[key];
    return preloadText.includes(`"${channelValue}"`) || preloadText.includes(`'${channelValue}'`);
  });

  const missing = exposedKeys.filter((key) => !registeredKeys.has(key));
  assert.deepStrictEqual(
    missing,
    [],
    `channels exposed via preload.js but never registered with a scope: ${missing.join(", ")}`
  );
});
