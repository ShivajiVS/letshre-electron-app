/**
 * Crash-durable spill store for recording chunks.
 *
 * screenRecorder.js held the whole upload backlog in two in-process arrays, so
 * a quit/crash/power-loss between the last successful chunk and /complete lost
 * the recording with nothing left to recover from. Chunks are now written here
 * the moment they arrive and only unlinked once the backend has confirmed
 * them, so an interrupted upload can be resumed on the next launch.
 *
 * Layout:
 *   <userData>/pending-uploads/<sessionKey>/manifest.json
 *   <userData>/pending-uploads/<sessionKey>/chunk_<index>.webm
 *
 * A session directory outliving the process IS the recovery record — it is
 * removed only after /complete succeeds. No Electron imports: this runs under
 * plain `node --test`.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MANIFEST_NAME = "manifest.json";
const CHUNK_PREFIX = "chunk_";
const CHUNK_SUFFIX = ".webm";

// Sessions older than this are abandoned — the backend's own upload session
// will have expired long before, so retrying them only wastes bandwidth and
// disk. Purged on init().
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let rootDir = null;

function _assertInitialised() {
  if (!rootDir) {
    throw new Error("pendingUploads: init(baseDir) must be called first");
  }
}

function _sessionDir(sessionKey) {
  _assertInitialised();
  return path.join(rootDir, sessionKey);
}

function _manifestPath(sessionKey) {
  return path.join(_sessionDir(sessionKey), MANIFEST_NAME);
}

function _chunkPath(sessionKey, index) {
  return path.join(_sessionDir(sessionKey), `${CHUNK_PREFIX}${index}${CHUNK_SUFFIX}`);
}

/**
 * Manifest writes go through a temp file + rename so a crash mid-write can
 * never leave a half-written JSON that makes the whole session unreadable —
 * rename is atomic within a directory on both NTFS and POSIX.
 */
function _writeManifest(sessionKey, manifest) {
  const target = _manifestPath(sessionKey);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function readManifest(sessionKey) {
  try {
    return JSON.parse(fs.readFileSync(_manifestPath(sessionKey), "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} baseDir Typically app.getPath("userData").
 */
function init(baseDir) {
  rootDir = path.join(baseDir, "pending-uploads");
  fs.mkdirSync(rootDir, { recursive: true });
  return _purgeExpired();
}

function _purgeExpired() {
  const purged = [];
  for (const sessionKey of _listSessionKeys()) {
    const manifest = readManifest(sessionKey);
    const createdAt = manifest?.createdAt ?? 0;
    if (Date.now() - createdAt > MAX_SESSION_AGE_MS) {
      destroySession(sessionKey);
      purged.push(sessionKey);
    }
  }
  return purged;
}

function _listSessionKeys() {
  _assertInitialised();
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Opens a session directory. Called as recording starts — before /start has
 * necessarily resolved, so uploadId is filled in later via setUploadId().
 * interviewId/fileName are recorded now because a resume after restart needs
 * them to re-register the upload session from scratch.
 */
function createSession({ sessionKey, interviewId, fileName }) {
  fs.mkdirSync(_sessionDir(sessionKey), { recursive: true });
  _writeManifest(sessionKey, {
    sessionKey,
    interviewId: interviewId ?? null,
    fileName: fileName ?? null,
    uploadId: null,
    createdAt: Date.now(),
  });
}

function setUploadId(sessionKey, uploadId) {
  const manifest = readManifest(sessionKey);
  if (!manifest) {
    return false;
  }
  manifest.uploadId = uploadId;
  _writeManifest(sessionKey, manifest);
  return true;
}

/**
 * Written synchronously: the chunk must be durable before it is queued for
 * upload, otherwise the crash window this module exists to close is still
 * open. ~2.5MB roughly once a minute, so the main-thread cost is negligible.
 * @param {Uint8Array|Buffer} bytes
 */
function saveChunk(sessionKey, index, bytes) {
  fs.writeFileSync(_chunkPath(sessionKey, index), Buffer.from(bytes));
}

function readChunk(sessionKey, index) {
  return fs.readFileSync(_chunkPath(sessionKey, index));
}

function removeChunk(sessionKey, index) {
  try {
    fs.unlinkSync(_chunkPath(sessionKey, index));
    return true;
  } catch {
    return false;
  }
}

/** Chunk indices still on disk, ascending — i.e. not yet confirmed uploaded. */
function listChunkIndices(sessionKey) {
  try {
    return fs
      .readdirSync(_sessionDir(sessionKey))
      .filter((name) => name.startsWith(CHUNK_PREFIX) && name.endsWith(CHUNK_SUFFIX))
      .map((name) => Number(name.slice(CHUNK_PREFIX.length, -CHUNK_SUFFIX.length)))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function destroySession(sessionKey) {
  try {
    fs.rmSync(_sessionDir(sessionKey), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sessions left behind by a previous run, oldest first. A directory with no
 * readable manifest is unrecoverable (we would not know which interview it
 * belongs to), so it is dropped rather than reported.
 */
function listPending() {
  const sessions = [];
  for (const sessionKey of _listSessionKeys()) {
    const manifest = readManifest(sessionKey);
    if (!manifest) {
      destroySession(sessionKey);
      continue;
    }
    sessions.push({ ...manifest, chunkIndices: listChunkIndices(sessionKey) });
  }
  return sessions.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

module.exports = {
  MAX_SESSION_AGE_MS,
  init,
  createSession,
  setUploadId,
  readManifest,
  saveChunk,
  readChunk,
  removeChunk,
  listChunkIndices,
  destroySession,
  listPending,
};
