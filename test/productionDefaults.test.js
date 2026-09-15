/**
 * Guards the host + DevTools config in src/shared/constants.js.
 *
 * The interview and API hosts, and the DevTools toggle, are read straight from
 * the environment now — no built-in dev/prod fallback. These assert that
 * contract: the env is the only source, an absent env leaves the value unset,
 * and the DevTools toggle only turns on for the values it documents. The
 * committed .env.example must not carry a localhost value that could ship.
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

/** Runs fn with the given env vars set, then restores them. */
function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    freshConstants();
  }
}

test("the interview and API hosts are taken verbatim from the environment", () => {
  withEnv(
    {
      INTERVIEW_FRONTEND_BASE_URL: "https://interview.letshyre.com",
      API_BASE_URL: "https://api.letshyre.com",
    },
    () => {
      const { INTERVIEW_BASE_URL, API_BASE_URL } = freshConstants();
      assert.strictEqual(INTERVIEW_BASE_URL, "https://interview.letshyre.com");
      assert.strictEqual(API_BASE_URL, "https://api.letshyre.com");
    }
  );
});

test("an absent environment leaves the hosts unset — nothing is defaulted in", () => {
  withEnv({ INTERVIEW_FRONTEND_BASE_URL: undefined, API_BASE_URL: undefined }, () => {
    const { INTERVIEW_BASE_URL, API_BASE_URL } = freshConstants();
    assert.strictEqual(INTERVIEW_BASE_URL, undefined);
    assert.strictEqual(API_BASE_URL, undefined);
  });
});

test("the environment sets the hosts in a packaged build too, not just dev", () => {
  // process.defaultApp is undefined here, same as in a packaged build.
  withEnv(
    {
      INTERVIEW_FRONTEND_BASE_URL: "https://staging.letshyre.com",
      API_BASE_URL: "https://api.staging.letshyre.com",
    },
    () => {
      const { INTERVIEW_BASE_URL, API_BASE_URL } = freshConstants();
      assert.strictEqual(INTERVIEW_BASE_URL, "https://staging.letshyre.com");
      assert.strictEqual(API_BASE_URL, "https://api.staging.letshyre.com");
    }
  );
});

test(".env.example carries no localhost host that could ship in a build", () => {
  const example = fs.readFileSync(path.join(__dirname, "../.env.example"), "utf8");
  for (const line of example.split(/\r?\n/)) {
    if (/^\s*(INTERVIEW_FRONTEND_BASE_URL|API_BASE_URL)\s*=\s*\S/.test(line)) {
      assert.doesNotMatch(line, /localhost|127\.0\.0\.1/, `got ${line.trim()}`);
    }
  }
});

test("the update poll interval is a production cadence, not a debugging one", () => {
  const { UPDATE_CHECK_INTERVAL_MS } = freshConstants();

  assert.ok(
    UPDATE_CHECK_INTERVAL_MS >= 60 * 60 * 1000,
    `${UPDATE_CHECK_INTERVAL_MS}ms polls GitHub too often for shipped clients`
  );
});

test("DevTools is only opened from behind the DEVTOOLS_ENABLED guard", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("openDevTools") && !text.includes("DEVTOOLS_ENABLED")) {
          offenders.push(full);
        }
      }
    }
  };
  walk(path.join(__dirname, "../src"));

  assert.deepStrictEqual(offenders, []);
});

test("the DevTools toggle turns on for 'true' or '1' and nothing else", () => {
  for (const value of ["true", "TRUE", "1"]) {
    withEnv({ DEVTOOLS: value }, () => {
      assert.strictEqual(freshConstants().DEVTOOLS_ENABLED, true, `DEVTOOLS=${value}`);
    });
  }
  for (const value of ["false", "0", "yes", "", undefined]) {
    withEnv({ DEVTOOLS: value }, () => {
      assert.strictEqual(freshConstants().DEVTOOLS_ENABLED, false, `DEVTOOLS=${value}`);
    });
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
