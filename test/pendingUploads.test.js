"use strict";

/**
 * Tests for the recording spill store — the crash-recovery record behind
 * screenRecorder's upload pipeline. Pure fs, no Electron, so this runs under
 * plain `node --test` like ipcScope.test.js.
 *
 * The behaviours under test are the ones that decide whether an interrupted
 * upload is recoverable at all: a chunk stays on disk until the backend has
 * confirmed it, and a session directory survives until /complete succeeds.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const pendingUploads = require("../src/main/pendingUploads");

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-uploads-test-"));
  pendingUploads.init(dir);
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("a saved chunk survives as a file and reads back byte-identical", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    const bytes = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x00, 0xff]);
    pendingUploads.saveChunk("s1", 0, bytes);

    assert.deepStrictEqual(pendingUploads.readChunk("s1", 0), bytes);
  } finally {
    cleanup(root);
  }
});

test("listChunkIndices returns only unconfirmed chunks, in numeric order", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    // Deliberately out of order, and spanning a digit boundary so a
    // lexicographic sort would put 10 before 2.
    for (const i of [2, 10, 0, 1]) {
      pendingUploads.saveChunk("s1", i, Buffer.from([i]));
    }
    pendingUploads.removeChunk("s1", 1);

    assert.deepStrictEqual(pendingUploads.listChunkIndices("s1"), [0, 2, 10]);
  } finally {
    cleanup(root);
  }
});

test("uploadId set after /start resolves is readable back from the manifest", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    assert.strictEqual(pendingUploads.readManifest("s1").uploadId, null);

    pendingUploads.setUploadId("s1", "upload-abc");

    assert.strictEqual(pendingUploads.readManifest("s1").uploadId, "upload-abc");
  } finally {
    cleanup(root);
  }
});

test("listPending reports interrupted sessions with what a resume needs", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.setUploadId("s1", "upload-abc");
    pendingUploads.saveChunk("s1", 0, Buffer.from([1]));
    pendingUploads.saveChunk("s1", 1, Buffer.from([2]));

    const pending = pendingUploads.listPending();

    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].uploadId, "upload-abc");
    assert.strictEqual(pending[0].interviewId, "i1");
    assert.strictEqual(pending[0].fileName, "a.webm");
    assert.deepStrictEqual(pending[0].chunkIndices, [0, 1]);
  } finally {
    cleanup(root);
  }
});

test("a completed session leaves nothing behind to resume", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.saveChunk("s1", 0, Buffer.from([1]));
    pendingUploads.destroySession("s1");

    assert.deepStrictEqual(pendingUploads.listPending(), []);
  } finally {
    cleanup(root);
  }
});

test("a session whose chunks all uploaded is still pending until /complete", () => {
  const root = freshRoot();
  try {
    // The case that silently lost recordings before: every chunk is in, but
    // the merge was never triggered. The directory must survive so the next
    // launch can retry /complete on its own.
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.setUploadId("s1", "upload-abc");
    pendingUploads.saveChunk("s1", 0, Buffer.from([1]));
    pendingUploads.removeChunk("s1", 0);

    const pending = pendingUploads.listPending();

    assert.strictEqual(pending.length, 1);
    assert.deepStrictEqual(pending[0].chunkIndices, []);
    assert.strictEqual(pending[0].uploadId, "upload-abc");
  } finally {
    cleanup(root);
  }
});

test("a directory with no readable manifest is dropped rather than reported", () => {
  const root = freshRoot();
  try {
    // Nothing identifies which interview these bytes belong to, so they are
    // unrecoverable — reporting them would loop a resume that can never work.
    fs.mkdirSync(path.join(root, "pending-uploads", "orphan"), { recursive: true });
    fs.writeFileSync(path.join(root, "pending-uploads", "orphan", "chunk_0.webm"), "x");

    assert.deepStrictEqual(pendingUploads.listPending(), []);
    assert.strictEqual(fs.existsSync(path.join(root, "pending-uploads", "orphan")), false);
  } finally {
    cleanup(root);
  }
});

test("a half-written manifest does not make the session unreadable", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    // Simulates a crash during a manifest rewrite: the .tmp is the casualty,
    // the real manifest is untouched because rename is atomic.
    fs.writeFileSync(path.join(root, "pending-uploads", "s1", "manifest.json.tmp"), "{bro");

    assert.strictEqual(pendingUploads.readManifest("s1").interviewId, "i1");
    assert.strictEqual(pendingUploads.listPending().length, 1);
  } finally {
    cleanup(root);
  }
});

test("sessions past the max age are purged on init", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "old", interviewId: "i1", fileName: "a.webm" });
    const manifestPath = path.join(root, "pending-uploads", "old", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.createdAt = Date.now() - pendingUploads.MAX_SESSION_AGE_MS - 1000;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const purged = pendingUploads.init(root);

    assert.deepStrictEqual(purged, ["old"]);
    assert.deepStrictEqual(pendingUploads.listPending(), []);
  } finally {
    cleanup(root);
  }
});

test("a spilled chunk is not readable as plain video on disk", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    const bytes = Buffer.from("webm-bytes-of-a-candidate-screen");
    pendingUploads.saveChunk("s1", 0, bytes);

    const onDisk = fs.readFileSync(path.join(root, "pending-uploads", "s1", "chunk_0.webm"));
    assert.strictEqual(onDisk.includes(bytes), false);
  } finally {
    cleanup(root);
  }
});

test("a chunk altered on disk is refused rather than uploaded", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.saveChunk("s1", 0, Buffer.from("original"));

    const file = path.join(root, "pending-uploads", "s1", "chunk_0.webm");
    const onDisk = fs.readFileSync(file);
    onDisk[onDisk.length - 1] ^= 0xff;
    fs.writeFileSync(file, onDisk);

    assert.throws(() => pendingUploads.readChunk("s1", 0));
  } finally {
    cleanup(root);
  }
});

test("a chunk moved to another index is refused", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.saveChunk("s1", 0, Buffer.from("first"));
    const dir = path.join(root, "pending-uploads", "s1");
    fs.renameSync(path.join(dir, "chunk_0.webm"), path.join(dir, "chunk_5.webm"));

    assert.throws(() => pendingUploads.readChunk("s1", 5));
  } finally {
    cleanup(root);
  }
});

test("chunks sealed under one key cannot be read with another", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.saveChunk("s1", 0, Buffer.from("secret"));

    pendingUploads.init(root);

    assert.throws(() => pendingUploads.readChunk("s1", 0));
  } finally {
    cleanup(root);
  }
});

test("the same key reads chunks back after a restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-uploads-test-"));
  const key = Buffer.alloc(32, 7);
  try {
    pendingUploads.init(root, key);
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    pendingUploads.saveChunk("s1", 0, Buffer.from("survives"));

    pendingUploads.init(root, Buffer.from(key));

    assert.strictEqual(pendingUploads.readChunk("s1", 0).toString(), "survives");
  } finally {
    cleanup(root);
  }
});

test("a plaintext chunk left by an older build still reads back", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "s1", interviewId: "i1", fileName: "a.webm" });
    const legacy = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    fs.writeFileSync(path.join(root, "pending-uploads", "s1", "chunk_0.webm"), legacy);

    assert.deepStrictEqual(pendingUploads.readChunk("s1", 0), legacy);
  } finally {
    cleanup(root);
  }
});

test("a fresh session is not purged on init", () => {
  const root = freshRoot();
  try {
    pendingUploads.createSession({ sessionKey: "new", interviewId: "i1", fileName: "a.webm" });

    assert.deepStrictEqual(pendingUploads.init(root), []);
    assert.strictEqual(pendingUploads.listPending().length, 1);
  } finally {
    cleanup(root);
  }
});
