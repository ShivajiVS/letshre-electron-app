/**
 * Binds the two copies of the process-name sanitisation rule.
 *
 * `validateProcessName()` in src/main/ipcHandlers.js strips characters outside
 * [\w.\- ] before a name reaches processKiller, so kill results come back under
 * the stripped spelling; the renderer's `sanitiseProcessKey()` mirrors the same
 * regex so it can match that result to the row it drew. Neither file can
 * import the other (renderer is sandboxed), so if main's rule ever drifts, the
 * renderer silently stops matching and rows report failures they didn't have —
 * hence a source-level assertion instead. Same approach as
 * test/preflightBudget.test.js.
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
  // Kill rows are only ever drawn for names from ALL_BLOCKED_APPS, and
  // sanitising those must be a no-op — otherwise the renderer would be
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
