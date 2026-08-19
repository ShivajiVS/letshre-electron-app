"use strict";

/**
 * Exhaustive coverage of src/shared/authValidators.js: every malformed email
 * shape, every password rule failing individually and in combination, and
 * the boundary between valid/invalid at each length limit.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  EMAIL_MAX_LEN,
  PASSWORD_MAX_LEN,
  PASSWORD_MIN_LEN,
  validateEmail,
  validatePassword,
} = require("../src/shared/authValidators");

test("validateEmail: empty and whitespace-only are required", () => {
  assert.strictEqual(validateEmail("").valid, false);
  assert.strictEqual(validateEmail("").code, "required");
  assert.strictEqual(validateEmail("   ").code, "required");
  assert.strictEqual(validateEmail(undefined).code, "required");
  assert.strictEqual(validateEmail(null).code, "required");
});

test("validateEmail: malformed shapes are invalid", () => {
  for (const bad of [
    "no-at-sign.com",
    "two@@signs.com",
    "@nodomain.com",
    "user@",
    "user@nodot",
    "has spaces@x.com",
    "user@domain.c", // TLD too short (regex requires 2+)
  ]) {
    assert.strictEqual(validateEmail(bad).valid, false, `expected "${bad}" to be invalid`);
    assert.strictEqual(validateEmail(bad).code, "invalid");
  }
});

test("validateEmail: well-formed addresses are valid", () => {
  for (const good of [
    "a@b.co",
    "shivajikv55@gmail.com",
    "first.last+tag@sub.example.co.uk",
  ]) {
    const r = validateEmail(good);
    assert.strictEqual(r.valid, true, `expected "${good}" to be valid`);
    assert.strictEqual(r.code, null);
  }
});

test("validateEmail: trims surrounding whitespace before checking", () => {
  assert.strictEqual(validateEmail("  a@b.co  ").valid, true);
});

test("validateEmail: oversized input is tooLong, not invalid", () => {
  const huge = `${"a".repeat(EMAIL_MAX_LEN)}@b.com`;
  const r = validateEmail(huge);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.code, "tooLong");
});

test("validatePassword: empty is required and blocks (the one hard case)", () => {
  const r = validatePassword("");
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.code, "required");
  assert.deepStrictEqual(r.failedRules, []);
});

test("validatePassword: oversized input is tooLong", () => {
  const r = validatePassword("a".repeat(PASSWORD_MAX_LEN + 1));
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.code, "tooLong");
});

test("validatePassword: complexity misses are reported but NEVER block (valid stays true)", () => {
  // Deliberately weak passwords — this is the core production-safety
  // guarantee: a real account's existing (weaker) password must still be
  // able to log in. Only failedRules reports what's missing.
  const cases = [
    { pw: "alllowercase1!", missing: ["uppercase"] },
    { pw: "ALLUPPERCASE1!", missing: ["lowercase"] },
    { pw: "NoDigitsHere!", missing: ["digit"] },
    { pw: "NoSymbol123", missing: ["symbol"] },
    { pw: "abc123", missing: ["minLength", "uppercase", "symbol"] }, // classic legacy password
    { pw: "short1!", missing: ["minLength"] },
  ];
  for (const { pw, missing } of cases) {
    const r = validatePassword(pw);
    assert.strictEqual(r.valid, true, `"${pw}" must not be blocked by complexity`);
    assert.strictEqual(r.code, null);
    for (const rule of missing) {
      assert.ok(r.failedRules.includes(rule), `"${pw}" should report missing rule "${rule}"`);
    }
  }
});

test("validatePassword: a password meeting every rule reports no failedRules", () => {
  const r = validatePassword("GoodPass1!");
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.failedRules, []);
});

test("validatePassword: boundary length — exactly PASSWORD_MIN_LEN passes minLength", () => {
  const exact = `Aa1!${"x".repeat(PASSWORD_MIN_LEN - 4)}`;
  assert.strictEqual(exact.length, PASSWORD_MIN_LEN);
  assert.ok(!validatePassword(exact).failedRules.includes("minLength"));
});

test("validatePassword: one character under PASSWORD_MIN_LEN fails minLength", () => {
  const short = `Aa1!${"x".repeat(PASSWORD_MIN_LEN - 5)}`;
  assert.strictEqual(short.length, PASSWORD_MIN_LEN - 1);
  assert.ok(validatePassword(short).failedRules.includes("minLength"));
});

test("validatePassword: unicode-only passwords fail ASCII-scoped rules sensibly, not silently", () => {
  // Cyrillic/Devanagari letters aren't [A-Z]/[a-z] under this regex — by
  // design (documented in authValidators.js), asserted explicitly here so a
  // future "let's make this unicode-aware" change doesn't silently pass.
  const cyrillicOnly = "пароль12345";
  const r = validatePassword(cyrillicOnly);
  assert.ok(r.failedRules.includes("uppercase"));
  assert.ok(r.failedRules.includes("symbol"));
});
