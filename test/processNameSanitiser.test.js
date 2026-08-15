/**
 * test/processNameSanitiser.test.js
 * ─────────────────────────────────
 * Binds the two copies of the process-name sanitisation rule.
 *
 * `validateProcessName()` in src/main/ipcHandlers.js strips characters outside
 * [\w.\- ] before a name reaches processKiller, so a kill result comes back
 * under the STRIPPED spelling. The renderer therefore mirrors the same regex in
 * `sanitiseProcessKey()` so it can still match that result to the row it drew.
 *
 * Two copies of one rule in two processes is a drift hazard: if main's sanitiser
 * ever changes, the renderer silently stops matching and every affected row
 * reports a failure it did not have. Neither file can import the other (the
 * renderer is sandboxed and cannot require local modules — the same constraint
 * that forces the IPC channel names and the scan-budget constant to be mirrored
 * rather than shared), so a source-level assertion is the only binding available.
 *
 * Same approach as test/preflightBudget.test.js.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/** Pulls the character class out of a `.replace(/[^...]/g, "")` call. */
function extractStripClass(src, label) {
  const match = src.match(/replace\(\/\[\^([^\]]+)\]\/g,\s*""\)/);
  assert.ok(match, `could not find the strip regex in ${label}`);
  return match[1];
}

test("renderer's sanitiseProcessKey mirrors main's validateProcessName rule", () => {
  const mainClass = extractStripClass(read("src/main/ipcHandlers.js"), "ipcHandlers.js");
  const rendererClass = extractStripClass(read("src/renderer/preflight.js"), "preflight.js");

  assert.strictEqual(
    rendererClass,
    mainClass,
    "the renderer's process-name sanitiser drifted from the main-process one — " +
      "kill results will stop matching their rendered rows"
  );
});

test("the shared rule preserves every name on the blocklist unchanged", () => {
  // The practical guarantee that makes the mirror safe: kill rows are only ever
  // drawn for names that came from ALL_BLOCKED_APPS, and sanitising those is a
  // no-op. If a blocklist entry ever needed stripping, the renderer would be
  // matching on a spelling that never appears on screen.
  const { ALL_BLOCKED_APPS } = require("../src/shared/appList");
  const strip = (s) => s.replace(/[^\w.\- ]/g, "");

  for (const name of ALL_BLOCKED_APPS) {
    assert.strictEqual(
      strip(name),
      name,
      `blocklist entry "${name}" is altered by the sanitiser — it would never match its rendered row`
    );
  }
});
