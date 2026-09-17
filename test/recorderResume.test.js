/**
 * Crash recovery end to end: real spill files, the real resume path, a stubbed
 * backend. Outside Electron `require("electron")` is a path string, which is
 * fine as long as no window code runs.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pendingUploads = require("../src/main/pendingUploads");
const authManager = require("../src/main/authManager");
const recorder = require("../src/main/screenRecorder");

recorder._testSeam.configure({ retryBaseMs: 1, retryCapMs: 1 });

/** Replaces the backend calls the resume path makes, recording what it did. */
function stubBackend({ startOk = true, chunkFails = new Set(), completeOk = true } = {}) {
  const calls = { started: 0, uploaded: [], completed: 0 };
  const original = {
    startVideoUpload: authManager.startVideoUpload,
    uploadVideoChunk: authManager.uploadVideoChunk,
    completeVideoUpload: authManager.completeVideoUpload,
  };

  authManager.startVideoUpload = async () => {
    calls.started++;
    return startOk ? { ok: true, uploadId: "upload-1" } : { ok: false, error: "start refused" };
  };
  authManager.uploadVideoChunk = async ({ chunkIndex, chunk }) => {
    if (chunkFails.has(chunkIndex)) {
      return { ok: false, error: `chunk ${chunkIndex} refused` };
    }
    calls.uploaded.push({ index: chunkIndex, bytes: Buffer.from(chunk).toString() });
    return { ok: true };
  };
  authManager.completeVideoUpload = async () => {
    calls.completed++;
    return completeOk ? { ok: true } : { ok: false, error: "complete refused" };
  };

  return { calls, restore: () => Object.assign(authManager, original) };
}

/** A spill directory holding an interrupted session, as a crash would leave it. */
function seedSession({ uploadId = "upload-1", interviewId = "iv-1", chunks = ["a", "b", "c"] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-resume-"));
  pendingUploads.init(root);
  const sessionKey = "session-1";
  pendingUploads.createSession({ sessionKey, interviewId, fileName: "rec.webm" });
  if (uploadId) {
    pendingUploads.setUploadId(sessionKey, uploadId);
  }
  chunks.forEach((body, i) => pendingUploads.saveChunk(sessionKey, i, Buffer.from(body)));
  return { root, sessionKey };
}

test("an interrupted session uploads every spilled chunk and then completes", async () => {
  const { root } = seedSession({});
  const backend = stubBackend({});

  try {
    const result = await recorder.resumePendingUploads();

    assert.deepStrictEqual(result, { resumed: 1, failed: 0 });
    assert.deepStrictEqual(
      backend.calls.uploaded.map((u) => u.bytes),
      ["a", "b", "c"],
      "every chunk uploads, in order, byte-identical"
    );
    assert.strictEqual(backend.calls.completed, 1);
    assert.deepStrictEqual(pendingUploads.listPending(), [], "session is cleaned up");
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a session whose /start never landed registers one before uploading", async () => {
  const { root } = seedSession({ uploadId: null, chunks: ["a"] });
  const backend = stubBackend({});

  try {
    const result = await recorder.resumePendingUploads();

    assert.strictEqual(backend.calls.started, 1, "resume registers the missing upload");
    assert.deepStrictEqual(result, { resumed: 1, failed: 0 });
    assert.strictEqual(backend.calls.completed, 1);
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a session with no uploadId and no interviewId is discarded, not retried forever", async () => {
  const { root } = seedSession({ uploadId: null, interviewId: null, chunks: ["a"] });
  const backend = stubBackend({});

  try {
    const result = await recorder.resumePendingUploads();

    assert.deepStrictEqual(result, { resumed: 0, failed: 1 });
    assert.strictEqual(backend.calls.started, 0);
    assert.deepStrictEqual(pendingUploads.listPending(), [], "nothing left to retry");
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a chunk that will not upload leaves the session pending and sends no /complete", async () => {
  // THE durability rule: completing a partial drain makes the backend merge a
  // truncated video and report success.
  const { root } = seedSession({ chunks: ["a"] });
  const backend = stubBackend({ chunkFails: new Set([0]) });

  try {
    const result = await recorder.resumePendingUploads();

    assert.deepStrictEqual(result, { resumed: 0, failed: 1 });
    assert.strictEqual(backend.calls.completed, 0, "/complete must not be sent");

    const [still] = pendingUploads.listPending();
    assert.ok(still, "session survives for the next launch");
    assert.deepStrictEqual(still.chunkIndices, [0], "the unsent chunk is still on disk");
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed /complete keeps the session for another attempt", async () => {
  const { root } = seedSession({ chunks: ["a"] });
  const backend = stubBackend({ completeOk: false });

  try {
    const result = await recorder.resumePendingUploads();

    assert.deepStrictEqual(result, { resumed: 0, failed: 1 });
    assert.ok(pendingUploads.listPending().length === 1, "session is not destroyed");
    assert.deepStrictEqual(
      pendingUploads.listPending()[0].chunkIndices,
      [],
      "confirmed chunks are gone; only /complete remains"
    );
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nothing pending is a no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-resume-"));
  pendingUploads.init(root);
  const backend = stubBackend({});

  try {
    assert.deepStrictEqual(await recorder.resumePendingUploads(), { resumed: 0, failed: 0 });
    assert.strictEqual(backend.calls.started, 0);
  } finally {
    backend.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
