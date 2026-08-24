"use strict";

/**
 * Covers the production locale gate: only `en` is human-certified today, so
 * a packaged build must only ever expose/resolve/accept `en`, while dev/QA
 * builds (app.isPackaged === false) keep all 19 locales testable. See
 * localeManager.js's `_localeAllowed()` and SUPPORTED_LOCALES' `reviewed`
 * flag in src/shared/constants.js.
 *
 * Mocking approach mirrors test/i18nBootstrap.test.js: "electron" is faked
 * via require.cache before localeManager is required, since localeManager
 * requires electron at module load for app.getPath/app.getLocale/app.isPackaged.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { SUPPORTED_LOCALES } = require("../src/shared/constants");

const ELECTRON_PATH = require.resolve("electron");
const LOCALE_MANAGER_PATH = require.resolve("../src/main/localeManager");

/** Points app.getPath("userData") at a fresh temp dir and sets isPackaged/getLocale. */
function fakeElectron({ isPackaged, osLocale = "en-US" }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "locale-gate-test-"));
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

function freshLocaleManager() {
  delete require.cache[LOCALE_MANAGER_PATH];
  return require("../src/main/localeManager");
}

test.afterEach(() => {
  delete require.cache[ELECTRON_PATH];
  delete require.cache[LOCALE_MANAGER_PATH];
});

test("packaged build: getSupportedLocales() returns only en", () => {
  fakeElectron({ isPackaged: true });
  const lm = freshLocaleManager();

  const locales = lm.getSupportedLocales();
  assert.deepStrictEqual(
    locales.map((l) => l.code),
    ["en"]
  );
});

test("packaged build: resolveInitialLocale() returns en even when the OS locale matches an unreviewed locale", () => {
  fakeElectron({ isPackaged: true, osLocale: "hi-IN" });
  const lm = freshLocaleManager();

  assert.strictEqual(lm.resolveInitialLocale(), "en");
});

test("packaged build: setPreferred('hi') resolves to en", async () => {
  fakeElectron({ isPackaged: true });
  const lm = freshLocaleManager();

  const applied = await lm.setPreferred("hi");
  assert.strictEqual(applied, "en");
});

test("dev/QA build: getSupportedLocales() returns all 19 locales", () => {
  fakeElectron({ isPackaged: false });
  const lm = freshLocaleManager();

  const locales = lm.getSupportedLocales();
  assert.strictEqual(locales.length, SUPPORTED_LOCALES.length);
  assert.deepStrictEqual(
    locales.map((l) => l.code).sort(),
    SUPPORTED_LOCALES.map((l) => l.code).sort()
  );
});

test("dev/QA build: resolveInitialLocale() still matches an unreviewed OS locale", () => {
  fakeElectron({ isPackaged: false, osLocale: "hi-IN" });
  const lm = freshLocaleManager();

  assert.strictEqual(lm.resolveInitialLocale(), "hi");
});

test("dev/QA build: setPreferred('hi') is accepted as-is", async () => {
  fakeElectron({ isPackaged: false });
  const lm = freshLocaleManager();

  const applied = await lm.setPreferred("hi");
  assert.strictEqual(applied, "hi");
});

test("packaged build: a preferences.json left over from a gated locale (e.g. dev/QA userData reused in a packaged build) is not trusted", () => {
  const userDataDir = fakeElectron({ isPackaged: true });
  fs.writeFileSync(path.join(userDataDir, "preferences.json"), JSON.stringify({ locale: "hi" }));
  const lm = freshLocaleManager();

  assert.strictEqual(lm.getPreferred(), "en");
});
