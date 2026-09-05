/**
 * Guards the agent drift check.
 *
 * The bundled agent is a separate binary from the app that ships it, so nothing
 * previously tied the two together: an agent left behind by an older install —
 * or swapped for one that reports no threats — passed preflight as long as its
 * contract_version was current.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SHA = "a".repeat(64);
const EXPECT_JSON = path.join(__dirname, "../src/shared/agentBuild.json");
const AGENT_BUILD = require.resolve("../src/shared/agentBuild");
const VERDICT = require.resolve("../src/detector/preflightVerdict");

const { agentSourceMatches } = require("../src/shared/agentBuild");

test("no shipped expectation means no opinion", () => {
  // A checkout that never built the agent has nothing to compare against, and
  // must not block itself.
  assert.strictEqual(agentSourceMatches("anything", null), true);
  assert.strictEqual(agentSourceMatches(undefined, null), true);
});

test("a matching hash passes and any other value fails", () => {
  assert.strictEqual(agentSourceMatches(SHA, SHA), true);
  assert.strictEqual(agentSourceMatches("b".repeat(64), SHA), false);
  assert.strictEqual(agentSourceMatches("", SHA), false);
});

test("an agent that reports no hash cannot pass a real expectation", () => {
  // Including "dev": a packaged build never runs the source agent, so a payload
  // claiming to be one is either wrong or forged.
  for (const reported of [undefined, null, 42, {}, "dev"]) {
    assert.strictEqual(agentSourceMatches(reported, SHA), false, `reported=${String(reported)}`);
  }
});

// The JSON has to leave the cache with the modules that read it — a stale entry
// outlives the file itself and the next read sees a hash that no longer exists.
function clearCache() {
  for (const id of [AGENT_BUILD, VERDICT, EXPECT_JSON]) {
    delete require.cache[id];
  }
}

/** Runs `fn` with a shipped expectation of `sha` in place, then restores. */
function withExpectation(sha, fn) {
  const had = fs.existsSync(EXPECT_JSON);
  const previous = had ? fs.readFileSync(EXPECT_JSON) : null;
  fs.writeFileSync(EXPECT_JSON, JSON.stringify({ source_sha: sha }));
  clearCache();
  try {
    fn();
  } finally {
    if (had) {
      fs.writeFileSync(EXPECT_JSON, previous);
    } else {
      fs.unlinkSync(EXPECT_JSON);
    }
    clearCache();
  }
}

/** Runs `fn` with no shipped expectation, restoring one if the machine had it. */
function withoutExpectation(fn) {
  const previous = fs.existsSync(EXPECT_JSON) ? fs.readFileSync(EXPECT_JSON) : null;
  if (previous) {
    fs.unlinkSync(EXPECT_JSON);
  }
  clearCache();
  try {
    fn();
  } finally {
    if (previous) {
      fs.writeFileSync(EXPECT_JSON, previous);
    }
    clearCache();
  }
}

test("expectedAgentSource reads the shipped hash", () => {
  withExpectation(SHA, () => {
    assert.strictEqual(require("../src/shared/agentBuild").expectedAgentSource(), SHA);
  });
});

test("mapAgent refuses an agent built from different source", () => {
  withExpectation(SHA, () => {
    const { mapAgent, PASS, UNVERIFIED } = require("../src/detector/preflightVerdict");
    const clean = { threats: [], safe_to_proceed: true, contract_version: 2, degraded: false };

    assert.strictEqual(
      mapAgent({ alive: true, status: { ...clean, source_sha: SHA } }).status,
      PASS
    );
    assert.strictEqual(
      mapAgent({ alive: true, status: { ...clean, source_sha: "b".repeat(64) } }).status,
      UNVERIFIED
    );
    assert.strictEqual(mapAgent({ alive: true, status: clean }).status, UNVERIFIED);
  });
});

test("expectedAgentSource is null when nothing was shipped", () => {
  withoutExpectation(() => {
    assert.strictEqual(require("../src/shared/agentBuild").expectedAgentSource(), null);
  });
});
