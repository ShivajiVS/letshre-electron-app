"use strict";

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOGGER = require.resolve("../src/main/logger");

let logger;
let dir;

const lastLine = () =>
  fs.readFileSync(path.join(dir, "secure-interview.log"), "utf8").trim().split("\n").at(-1);

beforeEach(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  delete require.cache[LOGGER];
  logger = require(LOGGER);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-"));
  logger.init(dir);
});

afterEach(() => {
  mock.restoreAll();
  delete require.cache[LOGGER];
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every line carries this launch's run id", () => {
  assert.match(logger.runId, /^[0-9a-f]{6}$/);
  logger.info("[test]", "hello");
  assert.match(lastLine(), new RegExp(`\\[INFO\\] \\[run:${logger.runId}\\] \\[test\\] hello$`));
});

test("during a session the line carries its id too, and drops it after", () => {
  logger.setSessionId("sess-42");
  logger.warn("[test]", "inside");
  assert.ok(lastLine().includes(`[run:${logger.runId} sess:sess-42] [test] inside`));

  logger.setSessionId(null);
  logger.info("[test]", "after");
  assert.ok(lastLine().includes(`[run:${logger.runId}] [test] after`));
});

test("a session id from the site can not break the line format", () => {
  logger.setSessionId("abc] [ERROR]\nfake");
  assert.strictEqual(logger.getSessionId(), "abcERRORfake");
  logger.setSessionId("  ");
  assert.strictEqual(logger.getSessionId(), null);
  logger.setSessionId(42);
  assert.strictEqual(logger.getSessionId(), null);
});

test("the run id stays the same for the whole launch", () => {
  const { runId } = logger;
  logger.setSessionId("s1");
  logger.setSessionId(null);
  assert.strictEqual(logger.runId, runId);
});
