"use strict";

/**
 * The live upload pipeline — chunks arriving during an interview — against a
 * stubbed backend and real spill files. No recorder window is involved.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pendingUploads = require("../src/main/pendingUploads");
const authManager = require("../src/main/authManager");
const recorder = require("../src/main/screenRecorder");

const seam = recorder._testSeam;
let online = true;
seam.configure({
  retryBaseMs: 1,
  retryCapMs: 1,
  retryAfterMs: 10,
  connectivityPollMs: 5,
  isOnline: () => online,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(5);
  }
}

function gate() {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function stubBackend({ startResults = [], uploadGate = null } = {}) {
  const calls = { started: 0, uploaded: [], completed: 0, inFlight: 0, maxInFlight: 0 };
  const original = {
    startVideoUpload: authManager.startVideoUpload,
    uploadVideoChunk: authManager.uploadVideoChunk,
    completeVideoUpload: authManager.completeVideoUpload,
    getVideoUploadStatus: authManager.getVideoUploadStatus,
  };

  authManager.startVideoUpload = async () => {
    const ok = startResults[calls.started] ?? true;
    calls.started++;
    return ok ? { ok: true, uploadId: "upload-1" } : { ok: false, error: "start refused" };
  };
  authManager.uploadVideoChunk = async ({ chunkIndex, chunk }) => {
    calls.inFlight++;
    calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
    if (uploadGate) {
      await uploadGate.opened;
    }
    calls.inFlight--;
    calls.uploaded.push({ index: chunkIndex, body: Buffer.from(chunk).toString() });
    return { ok: true };
  };
  authManager.completeVideoUpload = async () => {
    calls.completed++;
    return { ok: true };
  };
  authManager.getVideoUploadStatus = async () => ({ ok: true, status: "completed" });

  return { calls, restore: () => Object.assign(authManager, original) };
}

function withSpillStore(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-upload-"));
    pendingUploads.init(root);
    online = true;
    try {
      await fn();
    } finally {
      seam.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

const byIndex = (uploaded) =>
  [...uploaded].sort((a, b) => a.index - b.index).map((u) => `${u.index}:${u.body}`);

test(
  "a backlog past the in-memory cap drains in one go and then completes",
  withSpillStore(async () => {
    const uploadGate = gate();
    const backend = stubBackend({ uploadGate });
    try {
      seam.openSession({ interviewId: "iv-1" });
      for (let i = 0; i < 8; i++) {
        seam.onChunk(Buffer.from(`chunk-${i}`));
      }
      uploadGate.open();

      recorder.stop();
      await seam.finalize();

      assert.deepStrictEqual(
        byIndex(backend.calls.uploaded),
        Array.from({ length: 8 }, (_, i) => `${i}:chunk-${i}`),
        "chunks re-read from disk upload byte-identical"
      );
      assert.strictEqual(backend.calls.completed, 1);
      assert.deepStrictEqual(pendingUploads.listPending(), []);
    } finally {
      backend.restore();
    }
  })
);

test(
  "a failed /start is retried during the interview, not only after it",
  withSpillStore(async () => {
    const backend = stubBackend({ startResults: [false] });
    try {
      seam.openSession({ interviewId: "iv-1" });
      seam.onChunk(Buffer.from("a"));
      seam.onChunk(Buffer.from("b"));

      await waitFor(() => backend.calls.uploaded.length === 2);
      assert.strictEqual(backend.calls.started, 2);
      assert.strictEqual(backend.calls.completed, 0, "still recording");

      recorder.stop();
      await seam.finalize();

      assert.deepStrictEqual(byIndex(backend.calls.uploaded), ["0:a", "1:b"]);
      assert.strictEqual(backend.calls.completed, 1);
    } finally {
      backend.restore();
    }
  })
);

test(
  "uploads wait while offline and resume as soon as the connection returns",
  withSpillStore(async () => {
    seam.configure({ retryAfterMs: 60_000 });
    const backend = stubBackend();
    try {
      online = false;
      seam.openSession({ interviewId: "iv-1" });
      seam.onChunk(Buffer.from("a"));

      await sleep(40);
      assert.strictEqual(backend.calls.started, 0, "nothing is attempted while offline");

      online = true;
      await waitFor(() => backend.calls.uploaded.length === 1, 1000);
    } finally {
      backend.restore();
      seam.configure({ retryAfterMs: 10 });
    }
  })
);

test(
  "no more than two chunks upload at once",
  withSpillStore(async () => {
    const uploadGate = gate();
    const backend = stubBackend({ uploadGate });
    try {
      seam.openSession({ interviewId: "iv-1" });
      for (let i = 0; i < 5; i++) {
        seam.onChunk(Buffer.from(`c${i}`));
      }

      await waitFor(() => backend.calls.inFlight === 2);
      await sleep(20);
      assert.strictEqual(backend.calls.maxInFlight, 2);

      uploadGate.open();
      recorder.stop();
      await seam.finalize();

      assert.strictEqual(backend.calls.uploaded.length, 5);
      assert.strictEqual(backend.calls.completed, 1);
    } finally {
      backend.restore();
    }
  })
);
