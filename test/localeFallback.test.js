"use strict";

/**
 * Per-key runtime fallback: getTranslations() must deep-merge a locale's
 * bundle over English so any key missing from the locale resolves to the
 * English string instead of leaking a raw dotted key to the renderer.
 *
 * localeManager requires "electron" only for app.getPath, used by the
 * preference-file helpers — getTranslations() never touches app, so no
 * mocking is needed (require("electron") outside Electron just resolves to
 * the binary path string, which is never invoked here).
 *
 * The real assets/locales/*.json files have full key parity with en.json
 * (enforced by test/locales.test.js), so a genuine "missing key" gap is
 * simulated by mocking fs.readFileSync. Each such test reloads
 * localeManager fresh (via the require cache) so the module-level
 * _bundleCache doesn't leak fixture data into other tests.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const LOCALE_MANAGER_PATH = require.resolve("../src/main/localeManager");

/** Loads a fresh, uncached instance of localeManager. */
function freshLocaleManager() {
  delete require.cache[LOCALE_MANAGER_PATH];
  return require("../src/main/localeManager");
}

const EN_FIXTURE = {
  _meta: { locale: "en", name: "English", dir: "ltr" },
  common: { back: "Back", continue: "Continue" },
};

const DE_PARTIAL_FIXTURE = {
  _meta: { locale: "de", name: "Deutsch", dir: "ltr" },
  common: { back: "Zurück" }, // "continue" deliberately absent
};

/** Mocks fs.readFileSync to serve fixture JSON per locale code, from `bundles`. */
function mockReadFileSync(t, bundles, { onCall } = {}) {
  return t.mock.method(fs, "readFileSync", (fp, ...rest) => {
    const code = path.basename(String(fp), ".json");
    if (onCall) {onCall(code);}
    if (Object.prototype.hasOwnProperty.call(bundles, code)) {
      const value = bundles[code];
      if (value instanceof Error) {
        throw value;
      }
      return JSON.stringify(value);
    }
    throw new Error(`unexpected readFileSync for locale "${code}"`);
  });
}

test("key present in English but missing from a locale resolves to the English string", (t) => {
  const lm = freshLocaleManager();
  mockReadFileSync(t, { en: EN_FIXTURE, de: DE_PARTIAL_FIXTURE });

  const de = lm.getTranslations("de");
  assert.strictEqual(de.common.continue, "Continue");
});

test("a key present in the locale wins over English", (t) => {
  const lm = freshLocaleManager();
  mockReadFileSync(t, { en: EN_FIXTURE, de: DE_PARTIAL_FIXTURE });

  const de = lm.getTranslations("de");
  assert.strictEqual(de.common.back, "Zurück");
});

test("nested objects merge key-by-key rather than being replaced wholesale", (t) => {
  const lm = freshLocaleManager();
  mockReadFileSync(t, { en: EN_FIXTURE, de: DE_PARTIAL_FIXTURE });

  const de = lm.getTranslations("de");
  // de's "common" sub-object only overrides "back"; "continue" must survive
  // from English rather than the whole "common" object being replaced.
  assert.deepStrictEqual(Object.keys(de.common).sort(), ["back", "continue"]);
});

test("_meta.dir for a real ar bundle is still rtl after the merge (merge direction guard)", () => {
  const lm = freshLocaleManager();
  const en = lm.getTranslations("en");
  const ar = lm.getTranslations("ar");
  assert.notStrictEqual(en._meta.dir, "rtl");
  assert.strictEqual(ar._meta.dir, "rtl");
  assert.strictEqual(ar._meta.locale, "ar");
});

test("repeated calls return the cached instance and read the file only once", (t) => {
  const lm = freshLocaleManager();
  let calls = 0;
  mockReadFileSync(t, { en: EN_FIXTURE, de: DE_PARTIAL_FIXTURE }, { onCall: () => calls++ });

  const first = lm.getTranslations("de");
  const second = lm.getTranslations("de");
  assert.strictEqual(first, second);
  assert.strictEqual(calls, 2); // one read for de.json, one for the underlying en.json
});

test("an unsupported locale code coerces to English", () => {
  const lm = freshLocaleManager();
  const en = lm.getTranslations("en");
  const bogus = lm.getTranslations("not-a-real-locale");
  assert.strictEqual(bogus, en);
});

test("a locale bundle read/parse failure falls back fully to English", (t) => {
  const lm = freshLocaleManager();
  mockReadFileSync(t, { en: EN_FIXTURE, de: new Error("ENOENT: no such file") });

  const en = lm.getTranslations("en");
  const de = lm.getTranslations("de");
  assert.strictEqual(de, en);
});

test("an English bundle read/parse failure returns {} without infinite recursion", (t) => {
  const lm = freshLocaleManager();
  mockReadFileSync(t, { en: new Error("ENOENT: no such file") });

  const en = lm.getTranslations("en");
  assert.deepStrictEqual(en, {});
});
