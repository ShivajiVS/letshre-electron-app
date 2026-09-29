/**
 * Violation reports the backend has not confirmed yet, kept in one sealed file
 * so a quit or crash does not lose them:
 *
 *   <userData>/pending-violations.bin
 *
 * Sealed with AES-256-GCM under the recording spill key (spillKey.js), the same
 * way pendingUploads.js seals chunks. No Electron imports.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const FILE_NAME = "pending-violations.bin";
const MAGIC = Buffer.from("LHV1");
const LABEL = Buffer.from("pending-violations");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

let filePath = null;
let key = null;

/**
 * @param {string} baseDir Typically app.getPath("userData").
 * @param {Buffer} storeKey 32-byte key; reports sealed under another key cannot be read back.
 */
function init(baseDir, storeKey) {
  filePath = path.join(baseDir, FILE_NAME);
  key = storeKey;
}

function _seal(json) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(LABEL);
  const body = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function _open(file) {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a sealed report file");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    file.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  );
  decipher.setAAD(LABEL);
  decipher.setAuthTag(file.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES));
  return Buffer.concat([decipher.update(file.subarray(HEADER_BYTES)), decipher.final()]).toString(
    "utf8"
  );
}

/** Writes the whole queue; an empty queue removes the file. Never throws. */
function save(reports) {
  if (!filePath) {
    return;
  }
  try {
    if (reports.length === 0) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, _seal(JSON.stringify(reports)));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    logger.warn("[report-store] could not save unsent reports:", err.message);
  }
}

/** Reports left by a previous run, oldest first. An unreadable file is discarded. */
function load() {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    const reports = JSON.parse(_open(fs.readFileSync(filePath)));
    return Array.isArray(reports) ? reports.filter((r) => r && typeof r === "object") : [];
  } catch (err) {
    logger.warn("[report-store] unsent reports unreadable, discarding them:", err.message);
    save([]);
    return [];
  }
}

module.exports = { FILE_NAME, init, save, load };
