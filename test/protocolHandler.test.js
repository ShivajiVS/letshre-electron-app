"use strict";

/**
 * Covers the interview URL's `lang` query param: attached lazily on every
 * getCurrentInterviewUrl() read (not baked in when the URL is built), because
 * the language-selection page is shown after setInterviewSession() runs, so
 * the candidate's eventual choice doesn't exist yet at build time.
 *
 * Mocking approach mirrors test/localeGate.test.js: "electron" is faked via
 * require.cache before protocolHandler (which requires localeManager) is
 * required, since localeManager requires electron at module load for
 * app.getPath/app.getLocale/app.isPackaged.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ELECTRON_PATH = require.resolve("electron");
const LOCALE_MANAGER_PATH = require.resolve("../src/main/localeManager");
const PROTOCOL_HANDLER_PATH = require.resolve("../src/main/protocolHandler");

/** Points app.getPath("userData") at a fresh temp dir and sets isPackaged/getLocale. */
function fakeElectron({ isPackaged = false, osLocale = "en-US" } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-handler-test-"));
  require.cache[ELECTRON_PATH] = {
    id: ELECTRON_PATH,
    filename: ELECTRON_PATH,
    loaded: true,
    exports: {
      app: {
        isPackaged,
        getPath: (name) => (name === "userData" ? userDataDir : os.tmpdir()),
        getLocale: () => osLocale,
      },
    },
  };
  return userDataDir;
}

/** Fresh localeManager + protocolHandler pair, so protocolHandler's require()
 *  of localeManager picks up the fake electron rather than a cached real one. */
function freshProtocolHandler() {
  delete require.cache[LOCALE_MANAGER_PATH];
  delete require.cache[PROTOCOL_HANDLER_PATH];
  return require("../src/main/protocolHandler");
}

test.afterEach(() => {
  delete require.cache[ELECTRON_PATH];
  delete require.cache[LOCALE_MANAGER_PATH];
  delete require.cache[PROTOCOL_HANDLER_PATH];
});

test("lang is appended on the login flow (URL already has ac/rc)", async () => {
  fakeElectron({ isPackaged: false });
  const ph = freshProtocolHandler();
  const lm = require("../src/main/localeManager");
  await lm.setPreferred("te");

  ph.setInterviewSession("access-token-1", "refresh-token-1");
  const url = new URL(ph.getCurrentInterviewUrl());

  assert.strictEqual(url.searchParams.get("ac"), "access-token-1");
  assert.strictEqual(url.searchParams.get("rc"), "refresh-token-1");
  assert.strictEqual(url.searchParams.get("lang"), "te");
});

test("lang is appended even with no token (bare base URL, no pre-existing ?)", () => {
  fakeElectron({ isPackaged: false });
  const ph = freshProtocolHandler();
  // No setInterviewSession() call — currentInterviewUrl is the bare base URL,
  // which buildInterviewUrl() never appends "?" to. A naive `+= "&lang="`
  // here would produce a malformed URL ("...com&lang=en") instead of "?lang=en".
  const url = new URL(ph.getCurrentInterviewUrl());

  assert.strictEqual(url.searchParams.get("ac"), null);
  assert.strictEqual(url.searchParams.get("lang"), "en");
});

test("repeated getCurrentInterviewUrl() calls do not duplicate lang", () => {
  fakeElectron({ isPackaged: false });
  const ph = freshProtocolHandler();

  ph.setInterviewSession("ac1", "rc1");
  const first = new URL(ph.getCurrentInterviewUrl());
  const second = new URL(ph.getCurrentInterviewUrl());

  assert.strictEqual(first.searchParams.getAll("lang").length, 1);
  assert.strictEqual(second.searchParams.getAll("lang").length, 1);
});

test("lang reflects a locale chosen AFTER setInterviewSession() — the whole reason lang is resolved lazily", async () => {
  fakeElectron({ isPackaged: false });
  const ph = freshProtocolHandler();
  const lm = require("../src/main/localeManager");

  // setInterviewSession() runs on "Take Interview", before the candidate has
  // seen the language-selection page — the locale changes only afterward.
  ph.setInterviewSession("ac1", "rc1");
  await lm.setPreferred("ur");

  const url = new URL(ph.getCurrentInterviewUrl());
  assert.strictEqual(url.searchParams.get("lang"), "ur");
});

test("packaged build: lang stays en even when an unreviewed locale was requested", async () => {
  fakeElectron({ isPackaged: true });
  const ph = freshProtocolHandler();
  const lm = require("../src/main/localeManager");

  await lm.setPreferred("hi"); // gated — falls back to "en" internally
  ph.setInterviewSession("ac1", "rc1");

  const url = new URL(ph.getCurrentInterviewUrl());
  assert.strictEqual(url.searchParams.get("lang"), "en");
});

test("deep-link mid-interview reload path also carries lang (win.loadURL uses the getter)", async () => {
  fakeElectron({ isPackaged: false });
  const ph = freshProtocolHandler();
  const lm = require("../src/main/localeManager");
  await lm.setPreferred("ja");

  let loadedUrl = null;
  const fakeWin = {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    loadURL: (u) => {
      loadedUrl = u;
    },
  };

  ph.handleIncomingProtocol(
    "letshyre://start?ac=ac2&rc=rc2",
    fakeWin,
    /* isInterviewActive */ true,
    /* onViolation */ () => {}
  );

  assert.ok(loadedUrl, "expected win.loadURL to be called");
  const url = new URL(loadedUrl);
  assert.strictEqual(url.searchParams.get("lang"), "ja");
});
