"use strict";

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE = require.resolve("../src/main/reportStore");

let store;
let dir;
let file;
const key = crypto.randomBytes(32);
const reports = [
  { id: "a", code: "close_attempt", sessionId: "s1" },
  { id: "b", code: "blocked_app", sessionId: "s1", apps: ["Zoom"] },
];

beforeEach(() => {
  delete require.cache[STORE];
  store = require(STORE);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-store-"));
  file = path.join(dir, store.FILE_NAME);
  store.init(dir, key);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reports round-trip, oldest first", () => {
  store.save(reports);
  assert.deepStrictEqual(store.load(), reports);
});

test("reports are unreadable at rest", () => {
  store.save(reports);
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes(Buffer.from("close_attempt")));
  assert.ok(!raw.includes(Buffer.from("Zoom")));
});

test("an empty queue removes the file", () => {
  store.save(reports);
  store.save([]);
  assert.ok(!fs.existsSync(file));
  assert.deepStrictEqual(store.load(), []);
});

test("a file sealed under another key is discarded", () => {
  store.save(reports);
  store.init(dir, crypto.randomBytes(32));
  assert.deepStrictEqual(store.load(), []);
  assert.ok(!fs.existsSync(file));
});

test("a tampered file is discarded", () => {
  store.save(reports);
  const raw = fs.readFileSync(file);
  raw[raw.length - 1] ^= 0xff;
  fs.writeFileSync(file, raw);
  assert.deepStrictEqual(store.load(), []);
});

test("before init nothing is read or written", () => {
  delete require.cache[STORE];
  const fresh = require(STORE);
  fresh.save(reports);
  assert.deepStrictEqual(fresh.load(), []);
});
