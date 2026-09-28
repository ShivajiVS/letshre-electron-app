"use strict";

const { test, mock, afterEach } = require("node:test");
const assert = require("node:assert");

const pendingUploads = require("../src/main/pendingUploads");
const recorder = require("../src/main/screenRecorder");

const seam = recorder._testSeam;

afterEach(() => {
  seam.reset();
  mock.restoreAll();
  mock.timers.reset();
});

function openSession() {
  mock.method(pendingUploads, "createSession", () => {});
  seam.openSession({ interviewId: "int-1" });
}

test("there is no offset before anything records", () => {
  assert.strictEqual(recorder.getRecordingOffsetMs(), null);
});

test("the offset counts from the moment the recorder reports ready", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  openSession();
  assert.strictEqual(recorder.getRecordingOffsetMs(), null, "not capturing yet");

  seam.onRecorderReady();
  mock.timers.tick(4500);
  assert.strictEqual(recorder.getRecordingOffsetMs(), 4500);
});

test("the offset is gone once recording stops", () => {
  openSession();
  seam.onRecorderReady();
  assert.strictEqual(typeof recorder.getRecordingOffsetMs(), "number");

  recorder.stop();
  assert.strictEqual(recorder.getRecordingOffsetMs(), null);
});
