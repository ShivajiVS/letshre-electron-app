"use strict";

/**
 * Cases are drawn from the two releases that actually shipped broken, so this
 * suite fails on the real defects rather than invented ones.
 */

const test = require("node:test");
const assert = require("node:assert");

const { parseLatestYml, versionFromTag, verifyRelease } = require("../scripts/releaseManifest");

// Verbatim from the published v1.1.2 release — the last one that worked.
const GOOD_MANIFEST = `version: 1.1.2
files:
  - url: LetsHyre-Secure-Interview-Setup-1.1.2.exe
    sha512: ZnRhgStdE/brQjqI98po3WwHws+3bHTL1RsC550VlGCvyHRim8jnFt3DN4XUeW+noyOeXZxdaQ3k/JEMn74OXg==
    size: 86470260
path: LetsHyre-Secure-Interview-Setup-1.1.2.exe
sha512: ZnRhgStdE/brQjqI98po3WwHws+3bHTL1RsC550VlGCvyHRim8jnFt3DN4XUeW+noyOeXZxdaQ3k/JEMn74OXg==
releaseDate: '2026-06-20T09:56:43.971Z'
`;

const GOOD_ASSETS = [
  { name: "latest.yml", size: 378 },
  { name: "LetsHyre-Secure-Interview-Setup-1.1.2.exe", size: 86470260 },
  { name: "LetsHyre-Secure-Interview-Setup-1.1.2.exe.blockmap", size: 90297 },
];

test("parses the fields electron-builder emits", () => {
  const manifest = parseLatestYml(GOOD_MANIFEST);

  assert.strictEqual(manifest.version, "1.1.2");
  assert.strictEqual(manifest.path, "LetsHyre-Secure-Interview-Setup-1.1.2.exe");
  assert.deepStrictEqual(manifest.files, [
    { url: "LetsHyre-Secure-Interview-Setup-1.1.2.exe", size: 86470260 },
  ]);
});

test("strips the leading v from a tag", () => {
  assert.strictEqual(versionFromTag("v1.2.3"), "1.2.3");
  assert.strictEqual(versionFromTag("1.2.3"), "1.2.3");
});

test("a complete release passes", () => {
  const result = verifyRelease("v1.1.2", GOOD_MANIFEST, GOOD_ASSETS);

  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.ok, true);
});

test("rejects the v1.2.3 shape — blockmap uploaded, manifest and installer missing", () => {
  // Exactly what shipped: CI reported success and every client 404'd.
  const result = verifyRelease("v1.2.3", null, [
    { name: "LetsHyre-Secure-Interview-Setup-1.2.3.exe.blockmap", size: 121370 },
  ]);

  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("latest.yml is missing")));
});

test("rejects the v1.2.2 shape — manifest version disagrees with the tag", () => {
  // The v1.2.2 tag pointed at the 1.2.1 commit, so clients on 1.2.1 were
  // offered 1.2.1 and correctly did nothing.
  const manifest = `version: 1.2.1
files:
  - url: LetsHyre-Secure-Interview-Setup-1.2.1.exe
    sha512: L0RMkiLSclay7YRYEu+M4j1U54fS1YDPW41lKG8H9kl67fN+NZbjBt2Z7O9exYRxrtnzQgwHymTuOVmeJkfavg==
    size: 114786014
path: LetsHyre-Secure-Interview-Setup-1.2.1.exe
`;
  const result = verifyRelease("v1.2.2", manifest, [
    { name: "latest.yml", size: 379 },
    { name: "LetsHyre-Secure-Interview-Setup-1.2.1.exe", size: 114786014 },
  ]);

  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("declares version 1.2.1")));
});

test("rejects a manifest whose installer was never uploaded", () => {
  const result = verifyRelease("v1.1.2", GOOD_MANIFEST, [{ name: "latest.yml", size: 378 }]);

  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("was not uploaded")));
});

test("rejects a truncated installer", () => {
  const result = verifyRelease("v1.1.2", GOOD_MANIFEST, [
    { name: "latest.yml", size: 378 },
    { name: "LetsHyre-Secure-Interview-Setup-1.1.2.exe", size: 12345 },
  ]);

  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("truncated")));
});

test("rejects a manifest that names no installer", () => {
  const result = verifyRelease("v1.1.2", "version: 1.1.2\n", [{ name: "latest.yml", size: 20 }]);

  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("references no installer")));
});

test("a blockmap alongside a complete manifest is not required to be referenced", () => {
  // electron-builder does not list the blockmap in latest.yml; its presence or
  // absence must not decide the verdict either way.
  const withoutBlockmap = GOOD_ASSETS.filter((a) => !a.name.endsWith(".blockmap"));

  assert.strictEqual(verifyRelease("v1.1.2", GOOD_MANIFEST, withoutBlockmap).ok, true);
});
