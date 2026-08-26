"use strict";

/**
 * Source-introspection guards for screenRecorder's two silent-failure rules.
 * Style borrowed from ipcScope.test.js: the module pulls in BrowserWindow and
 * desktopCapturer at require() time, so its internals can't be exercised under
 * plain `node --test` — but the invariants below are exactly the ones whose
 * breakage produces no error anywhere, so they are worth pinning structurally
 * rather than leaving to review.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "main", "screenRecorder.js"),
  "utf8"
);

test("/complete is only ever sent from the retry wrapper", () => {
  // A direct authManager.completeVideoUpload() call elsewhere would bypass
  // both the drain check and the retries — the exact shape of the original
  // bug, where a partial upload was reported to the backend as finished.
  const callSites = [...SOURCE.matchAll(/authManager\.completeVideoUpload\(/g)].length;
  assert.strictEqual(
    callSites,
    1,
    "completeVideoUpload must be called only inside _completeWithRetry()"
  );
});

test("the /complete path refuses to finalise while chunks are still queued", () => {
  const fn = SOURCE.match(/async function _completeIfDrained\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate _completeIfDrained()");

  const body = fn[1];
  const guardIndex = body.indexOf("chunkQueue.length > 0");
  const completeIndex = body.indexOf("_completeWithRetry");

  assert.notStrictEqual(guardIndex, -1, "_completeIfDrained must check chunkQueue.length");
  assert.notStrictEqual(completeIndex, -1, "_completeIfDrained must call _completeWithRetry");
  assert.ok(
    guardIndex < completeIndex,
    "the queue check must come before /complete — completing a partial drain merges a truncated video and still reports success"
  );
});

test("a chunk's spill copy is only removed after the upload is confirmed", () => {
  // removeChunk before the await would reopen the crash window: the bytes
  // would be gone from disk while still unconfirmed by the backend.
  const pump = SOURCE.match(/function _pump\(\)\s*\{([\s\S]*?)\n\}\n/);
  assert.ok(pump, "could not locate _pump()");

  const body = pump[1];
  const uploadIndex = body.indexOf("await _uploadWithRetry");
  const removeIndex = body.indexOf("pendingUploads.removeChunk");

  assert.notStrictEqual(uploadIndex, -1, "_pump must upload via _uploadWithRetry");
  assert.notStrictEqual(removeIndex, -1, "_pump must drop the spill copy once uploaded");
  assert.ok(removeIndex > uploadIndex, "removeChunk must follow a confirmed upload, not precede it");
});

test("_notifyProctoringError delegates to the push helper rather than itself", () => {
  // It is the only caller of PUSH_PROCTORING_ERROR, so a careless rewrite of
  // its own body into a self-call recurses forever — and only on the error
  // path, where nothing routinely exercises it.
  const fn = SOURCE.match(/function _notifyProctoringError\(message\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate _notifyProctoringError()");
  assert.ok(
    !fn[1].includes("_notifyProctoringError("),
    "_notifyProctoringError must not call itself"
  );
  assert.ok(
    fn[1].includes("_pushToInterviewPage("),
    "_notifyProctoringError must push to the interview page when it is still loaded"
  );
});

test("every proctoring error goes through the notifier, not a raw push", () => {
  const rawPushes = [...SOURCE.matchAll(/_pushToInterviewPage\(IPC\.PUSH_PROCTORING_ERROR/g)].length;
  assert.strictEqual(
    rawPushes,
    1,
    "PUSH_PROCTORING_ERROR should be sent only from _notifyProctoringError, which falls back to a dialog once the interview page is gone"
  );
});

test("resume never completes a session it could not fully drain", () => {
  const fn = SOURCE.match(/async function _resumeSession\(session\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate _resumeSession()");

  const body = fn[1];
  const loopIndex = body.indexOf("for (const index of chunkIndices)");
  const completeIndex = body.indexOf("_completeWithRetry");

  assert.ok(loopIndex !== -1 && completeIndex !== -1, "resume must drain, then complete");
  assert.ok(loopIndex < completeIndex, "the drain loop must precede /complete");
  assert.ok(
    body.slice(loopIndex, completeIndex).includes("return false"),
    "a failed chunk must abort the resume before /complete, leaving the session on disk"
  );
});
