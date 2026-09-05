/**
 * The renderer half of the kill-result contract.
 *
 * preflight.js is a classic script with no exports, so these assert on its
 * source. Weaker than calling the function, but they fail if the wiring is
 * deleted — which is what happened to the elevated retry for service-backed
 * apps: main reported it and the renderer never read it.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "../src/renderer/preflight.js"), "utf8");

test("the kill result normaliser carries serviceBacked through", () => {
  assert.match(SOURCE, /serviceBacked: raw\?\.serviceBacked === true/);
});

test("a service-backed respawn offers the elevated retry", () => {
  // Only elevation stops the service. Everything else respawns because of a
  // user-level auto-start, where elevation would change nothing.
  assert.match(
    SOURCE,
    /norm\.serviceBacked && _canElevate && !_elevationTried\.has\(processName\)/
  );
});

test("the elevated retry stays one-shot", () => {
  // Re-offering it loops a UAC prompt the candidate already declined.
  const offers = SOURCE.match(/_elevationTried\.has\(processName\)/g) || [];
  assert.strictEqual(offers.length, 2, "access-denied and respawned, both guarded");
  assert.match(SOURCE, /_elevationTried\.add\(processName\)/);
});
