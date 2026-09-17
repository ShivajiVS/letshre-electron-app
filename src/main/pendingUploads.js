/**
 * Crash-durable spill store for recording chunks. A chunk is written here the
 * moment it arrives and only removed once the backend confirms it, so an
 * interrupted upload can be resumed on the next launch.
 *
 *   <userData>/pending-uploads/<sessionKey>/manifest.json
 *   <userData>/pending-uploads/<sessionKey>/chunk_<index>.webm
 *
 * Chunks are sealed with AES-256-GCM: the recording is unreadable at rest, and
 * a chunk that was altered or moved to another index fails to open instead of
 * being uploaded. No Electron imports, so this runs under plain `node --test`.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MANIFEST_NAME = "manifest.json";
const CHUNK_PREFIX = "chunk_";
const CHUNK_SUFFIX = ".webm";

const SEALED_MAGIC = Buffer.from("LHE1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SEALED_MAGIC.length + IV_BYTES + TAG_BYTES;

// The backend's upload session has long expired by then.
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let rootDir = null;
let key = null;

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

/** Temp file + rename, so a crash mid-write never leaves a half-written file behind. */
function _writeAtomic(target, data) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function _chunkLabel(sessionKey, index) {
  return Buffer.from(`${sessionKey}:${index}`);
}

function _seal(sessionKey, index, bytes) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(_chunkLabel(sessionKey, index));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([SEALED_MAGIC, iv, cipher.getAuthTag(), body]);
}

function _open(sessionKey, index, file) {
  // Chunks spilled by a build that predates encryption.
  if (!file.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) {
    return file;
  }
  const iv = file.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + IV_BYTES);
  const tag = file.subarray(SEALED_MAGIC.length + IV_BYTES, HEADER_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(_chunkLabel(sessionKey, index));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(file.subarray(HEADER_BYTES)), decipher.final()]);
}

function _writeManifest(sessionKey, manifest) {
  _writeAtomic(_manifestPath(sessionKey), JSON.stringify(manifest, null, 2));
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
 * @param {Buffer} [spillKey] 32-byte key. Without a persisted one, chunks from
 *   this run cannot be read back after a restart.
 */
function init(baseDir, spillKey = crypto.randomBytes(32)) {
  rootDir = path.join(baseDir, "pending-uploads");
  key = spillKey;
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

/** uploadId is filled in later via setUploadId(), once /start resolves. */
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
 * Synchronous on purpose: the chunk must be durable before it is queued.
 * @param {Uint8Array|Buffer} bytes
 */
function saveChunk(sessionKey, index, bytes) {
  _writeAtomic(_chunkPath(sessionKey, index), _seal(sessionKey, index, Buffer.from(bytes)));
}

/** Throws if the chunk is missing, tampered with, or sealed under another key. */
function readChunk(sessionKey, index) {
  return _open(sessionKey, index, fs.readFileSync(_chunkPath(sessionKey, index)));
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
 * Sessions left behind by a previous run, oldest first. Without a manifest we
 * cannot tell which interview the chunks belong to, so those are dropped.
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
