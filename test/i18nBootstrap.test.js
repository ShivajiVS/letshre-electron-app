"use strict";

/**
 * Covers the two changes made for the i18n boot-time optimization:
 *   1. localeManager.getBootstrap() — one call replacing getPreferred() + getTranslations().
 *   2. localeManager.setPreferred() — now async, read-modify-write instead of blind overwrite.
 *
 * setPreferred()/getPreferred() touch app.getPath("userData"), so "electron" is faked via
 * require.cache before localeManager is required — require("electron") outside a real Electron
 * process resolves to the CLI binary path string, not an { app } object, so app.getPath would
 * otherwise throw.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ELECTRON_PATH = require.resolve("electron");
const LOCALE_MANAGER_PATH = require.resolve("../src/main/localeManager");

/** Points app.getPath("userData") at a fresh temp directory and returns it. */
function fakeElectron() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-bootstrap-test-"));
  require.cache[ELECTRON_PATH] = {
    id: ELECTRON_PATH,
    filename: ELECTRON_PATH,
    loaded: true,
    exports: {
      app: {
        getPath: (name) => (name === "userData" ? userDataDir : os.tmpdir()),
        getLocale: () => "en-US",
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

test("getBootstrap() returns { locale, bundle } matching separate getPreferred()+getTranslations() calls", () => {
  fakeElectron();
  const lm = freshLocaleManager();

  const { locale, bundle } = lm.getBootstrap();
  assert.strictEqual(locale, lm.getPreferred());
  assert.deepStrictEqual(bundle, lm.getTranslations(locale));
});

test("setPreferred() is async and persists the chosen locale", async () => {
  const userDataDir = fakeElectron();
  const lm = freshLocaleManager();

  const result = lm.setPreferred("fr");
  assert.ok(typeof result.then === "function", "setPreferred() must return a Promise");
  const applied = await result;
  assert.strictEqual(applied, "fr");

  const written = JSON.parse(fs.readFileSync(path.join(userDataDir, "preferences.json"), "utf8"));
  assert.strictEqual(written.locale, "fr");
});

test("setPreferred() read-modify-writes — unrelated existing keys survive a locale switch", async () => {
  const userDataDir = fakeElectron();
  const prefsPath = path.join(userDataDir, "preferences.json");
  fs.writeFileSync(prefsPath, JSON.stringify({ locale: "en", someOtherFeatureFlag: true }), "utf8");

  const lm = freshLocaleManager();
  await lm.setPreferred("de");

  const written = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  assert.strictEqual(written.locale, "de");
  assert.strictEqual(written.someOtherFeatureFlag, true);
});

test("setPreferred() succeeds and writes valid JSON when preferences.json is missing", async () => {
  const userDataDir = fakeElectron();
  const prefsPath = path.join(userDataDir, "preferences.json");
  assert.strictEqual(fs.existsSync(prefsPath), false);

  const lm = freshLocaleManager();
  await lm.setPreferred("ja");

  const written = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  assert.strictEqual(written.locale, "ja");
});

test("setPreferred() succeeds and writes valid JSON when preferences.json is corrupt", async () => {
  const userDataDir = fakeElectron();
  const prefsPath = path.join(userDataDir, "preferences.json");
  fs.writeFileSync(prefsPath, "{ not valid json", "utf8");

  const lm = freshLocaleManager();
  await lm.setPreferred("es");

  const written = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  assert.strictEqual(written.locale, "es");
});
