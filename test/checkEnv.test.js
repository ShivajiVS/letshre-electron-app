"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { checkEnv } = require("../scripts/check-env");
const pkg = require("../package.json");

const PROD =
  "INTERVIEW_FRONTEND_BASE_URL=https://interview.letshyre.com\nAPI_BASE_URL=https://api.letshyre.com\n";

test("production hosts pass", () => {
  assert.deepStrictEqual(checkEnv(PROD), []);
});

test("a developer .env pointing at localhost is refused", () => {
  const problems = checkEnv(
    "# INTERVIEW_FRONTEND_BASE_URL=https://interview.letshyre.com\n" +
      "INTERVIEW_FRONTEND_BASE_URL=http://localhost:5173/\n" +
      "API_BASE_URL=https://api.letshyre.ai\n" +
      "DEVTOOLS=true\n"
  );
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /INTERVIEW_FRONTEND_BASE_URL points at a local host/);
});

test("loopback and .local hosts are refused", () => {
  for (const host of ["http://127.0.0.1:3000", "https://0.0.0.0", "https://box.local"]) {
    const problems = checkEnv(
      `INTERVIEW_FRONTEND_BASE_URL=${host}\nAPI_BASE_URL=https://api.x.com`
    );
    assert.match(problems.join(), /local host/, host);
  }
});

test("missing, malformed and plain-http hosts are refused", () => {
  assert.match(
    checkEnv("API_BASE_URL=https://api.x.com").join(),
    /INTERVIEW_FRONTEND_BASE_URL is not set/
  );
  assert.match(
    checkEnv("INTERVIEW_FRONTEND_BASE_URL=interview\nAPI_BASE_URL=https://api.x.com").join(),
    /not a valid URL/
  );
  assert.match(
    checkEnv(
      "INTERVIEW_FRONTEND_BASE_URL=http://interview.x.com\nAPI_BASE_URL=https://api.x.com"
    ).join(),
    /must use https/
  );
});

test("the check runs before every package, including CI's direct electron-builder call", () => {
  assert.strictEqual(pkg.build.beforePack, "scripts/check-env.js");
});
