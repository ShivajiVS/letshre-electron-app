"use strict";

/**
 * src/renderer/login.js hand-mirrors src/shared/authValidators.js (the
 * renderer is sandboxed and can't require() it — see that file's header).
 * This guards the mirror the same way test/preflightBudget.test.js guards
 * preflight.js's SCAN_TIMEOUT_MS mirror: by reading the renderer file's
 * source text rather than executing it (it touches `document` at module
 * scope, so it can't be require()'d directly under plain Node).
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const shared = require("../src/shared/authValidators");

const loginSrc = fs.readFileSync(
  path.join(__dirname, "../src/renderer/login.js"),
  "utf8"
);

function extractConst(name) {
  const match = loginSrc.match(new RegExp(`const ${name}\\s*=\\s*(\\d+);`));
  assert.ok(match, `could not find const ${name} in login.js`);
  return Number(match[1]);
}

test("login.js mirrors EMAIL_MAX_LEN / PASSWORD_MAX_LEN / PASSWORD_MIN_LEN", () => {
  assert.strictEqual(extractConst("EMAIL_MAX_LEN"), shared.EMAIL_MAX_LEN);
  assert.strictEqual(extractConst("PASSWORD_MAX_LEN"), shared.PASSWORD_MAX_LEN);
  assert.strictEqual(extractConst("PASSWORD_MIN_LEN"), shared.PASSWORD_MIN_LEN);
});

test("login.js mirrors EMAIL_REGEX exactly (same source text)", () => {
  const match = loginSrc.match(/const EMAIL_REGEX\s*=\s*(\/.*\/);/);
  assert.ok(match, "could not find EMAIL_REGEX in login.js");
  assert.strictEqual(match[1], shared.EMAIL_REGEX.toString());
});

test("login.js mirrors every PASSWORD_RULES id and test function body", () => {
  // Both files format PASSWORD_RULES one rule per line — matched line by
  // line rather than brace-counted, since the symbol rule's own character
  // class contains literal "{" and "}" that would confuse a naive
  // first-closing-brace match.
  for (const rule of shared.PASSWORD_RULES) {
    const lineMatch = loginSrc.match(new RegExp(`id:\\s*"${rule.id}"[^\\n]*`));
    assert.ok(lineMatch, `rule "${rule.id}" not found in login.js`);
    const bodyMatch = lineMatch[0].match(/test:\s*\(v\)\s*=>\s*(.+?),?\s*\},?\s*$/);
    assert.ok(bodyMatch, `could not parse test body for rule "${rule.id}" in login.js`);

    const sharedBody = rule.test.toString().replace(/^\(v\)\s*=>\s*/, "");
    assert.strictEqual(
      bodyMatch[1],
      sharedBody,
      `rule "${rule.id}" test body drifted from shared/authValidators.js`
    );
  }
});

test("validateEmail / validatePassword in login.js agree with the shared module on a sample set", () => {
  // Cheap end-to-end cross-check beyond the source-text diff above: extract
  // and eval the mirrored functions in an isolated scope, run the same
  // inputs through both, and assert identical results.
  const vm = require("node:vm");
  const context = { console };
  vm.createContext(context);
  // Only pull in what's needed to define the two functions, not the whole
  // file (which touches `document` at the bottom).
  const snippet = loginSrc
    .slice(0, loginSrc.indexOf("document.addEventListener"))
    .replace(/^function tr\([\s\S]*?\n\}\n/m, ""); // tr() needs `window`, unused by the validators
  vm.runInContext(snippet, context);

  // vm.createContext() runs code in a separate realm, so objects it returns
  // have a different Object.prototype — deepStrictEqual would fail on that
  // alone even with identical own properties. JSON round-trip strips it.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  const emailCases = ["", "  ", "a@b.co", "bad", "user@nodot", "shivajikv55@gmail.com"];
  for (const c of emailCases) {
    assert.deepStrictEqual(
      plain(context.validateEmail(c)),
      plain(shared.validateEmail(c)),
      `validateEmail("${c}") mismatch between login.js and shared/authValidators.js`
    );
  }

  const passwordCases = ["", "abc123", "GoodPass1!", "пароль12345", "a".repeat(300)];
  for (const c of passwordCases) {
    assert.deepStrictEqual(
      plain(context.validatePassword(c)),
      plain(shared.validatePassword(c)),
      `validatePassword("${c}") mismatch between login.js and shared/authValidators.js`
    );
  }
});
