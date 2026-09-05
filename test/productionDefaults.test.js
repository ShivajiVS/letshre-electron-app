/**
 * Guards the dev/prod split in src/shared/constants.js.
 *
 * v1.2.6 and v1.2.7 both shipped with INTERVIEW_BASE_URL pointing at
 * localhost:5173, and v1.2.7 with a 5-minute update poll. Both rode out inside
 * commits messaged "bump version". These assert the committed defaults are the
 * ones a candidate's machine should see.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CONSTANTS_PATH = require.resolve("../src/shared/constants");

/** Re-reads constants.js with the current process.env. */
function freshConstants() {
  delete require.cache[CONSTANTS_PATH];
  return require("../src/shared/constants");
}

test("the committed interview and API hosts are production HTTPS", () => {
  const { INTERVIEW_BASE_URL, API_BASE_URL } = freshConstants();

  assert.strictEqual(INTERVIEW_BASE_URL, "https://interview.letshyre.com");
  assert.strictEqual(API_BASE_URL, "https://api.letshyre.com");
});

test("the interview host has no trailing slash", () => {
  // windowManager passes it to clearStorageData({ origin }), which wants a bare
  // origin, and the startsWith guards would reject a bare-origin URL.
  const { INTERVIEW_BASE_URL } = freshConstants();

  assert.ok(!INTERVIEW_BASE_URL.endsWith("/"), `got ${INTERVIEW_BASE_URL}`);
  assert.strictEqual(new URL(INTERVIEW_BASE_URL).origin, INTERVIEW_BASE_URL);
});

test("the environment cannot repoint the hosts outside dev", () => {
  // process.defaultApp is undefined here, same as in a packaged build, so a
  // candidate setting these in their shell must not be able to redirect the
  // interview page or the API the app sends tokens to.
  const previous = {
    interview: process.env.INTERVIEW_FRONTEND_BASE_URL,
    api: process.env.API_BASE_URL,
  };
  process.env.INTERVIEW_FRONTEND_BASE_URL = "http://attacker.example";
  process.env.API_BASE_URL = "http://attacker.example";

  try {
    const { INTERVIEW_BASE_URL, API_BASE_URL } = freshConstants();

    assert.strictEqual(INTERVIEW_BASE_URL, "https://interview.letshyre.com");
    assert.strictEqual(API_BASE_URL, "https://api.letshyre.com");
  } finally {
    if (previous.interview === undefined) {
      delete process.env.INTERVIEW_FRONTEND_BASE_URL;
    } else {
      process.env.INTERVIEW_FRONTEND_BASE_URL = previous.interview;
    }
    if (previous.api === undefined) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = previous.api;
    }
    freshConstants();
  }
});

test("the update poll interval is a production cadence, not a debugging one", () => {
  const { UPDATE_CHECK_INTERVAL_MS } = freshConstants();

  assert.ok(
    UPDATE_CHECK_INTERVAL_MS >= 60 * 60 * 1000,
    `${UPDATE_CHECK_INTERVAL_MS}ms polls GitHub too often for shipped clients`
  );
});

test("no source file opens DevTools", () => {
  // Convenient in dev, but it ships. Open it by hand when debugging instead.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith(".js") &&
        fs.readFileSync(full, "utf8").includes("openDevTools")
      ) {
        offenders.push(full);
      }
    }
  };
  walk(path.join(__dirname, "../src"));

  assert.deepStrictEqual(offenders, []);
});

test("the DevTools key toggle stays off outside dev", () => {
  // process.defaultApp is undefined here, as in a packaged build, so setting
  // DEVTOOLS in a candidate's shell must not unlock the F12 lockdown.
  const previous = process.env.DEVTOOLS;
  process.env.DEVTOOLS = "1";

  try {
    assert.strictEqual(freshConstants().DEVTOOLS_ENABLED, false);
  } finally {
    if (previous === undefined) {
      delete process.env.DEVTOOLS;
    } else {
      process.env.DEVTOOLS = previous;
    }
    freshConstants();
  }
});

test("the input lockdown only lets DevTools keys through via the dev toggle", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/windowManager.js"), "utf8");

  assert.match(source, /isDevTools && !DEVTOOLS_ENABLED/);
});

test("packaged builds still force DevTools closed", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/windowManager.js"), "utf8");

  assert.match(source, /app\.isPackaged/);
  assert.match(source, /devtools-opened/);
  assert.match(source, /closeDevTools\(\)/);
});
