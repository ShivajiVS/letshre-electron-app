"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");
const logger = require("./logger");

const KEY_FILE = "spill.key";
const KEY_BYTES = 32;

/**
 * Key for recording chunks spilled to disk, sealed by the OS keystore so an
 * interrupted upload can still be read after a restart. Without a keystore the
 * key lives only in memory: chunks stay unreadable at rest but cannot resume.
 */
function loadSpillKey(baseDir) {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.warn(
      "[spill] OS keystore unavailable — interrupted uploads will not resume after restart"
    );
    return crypto.randomBytes(KEY_BYTES);
  }

  const file = path.join(baseDir, KEY_FILE);
  if (fs.existsSync(file)) {
    try {
      const stored = Buffer.from(safeStorage.decryptString(fs.readFileSync(file)), "base64");
      if (stored.length === KEY_BYTES) {
        return stored;
      }
      logger.error("[spill] stored key has the wrong length — replacing it");
    } catch (err) {
      logger.error("[spill] stored key unreadable — replacing it:", err.message);
    }
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, safeStorage.encryptString(key.toString("base64")));
  return key;
}

module.exports = { loadSpillKey };
