"use strict";

// 500 kbps is the floor: the recording shows a live camera feed, and below that
// faces smear badly enough to hurt the review.
const LADDER = [1_000_000, 750_000, 500_000];

/**
 * Picks the recorder's video bitrate from the upload backlog. Steps down while
 * uploads fall behind and back up only after they have kept pace for a while,
 * so a brief dip does not make quality flap.
 */
function createBitrateController({
  ladder = LADDER,
  stepDownAt = 3,
  calmAt = 1,
  holdMs = 45_000,
  stepUpAfterMs = 180_000,
} = {}) {
  let level = 0;
  let changedAt = -Infinity;
  let calmSince = null;

  return {
    get bitsPerSecond() {
      return ladder[level];
    },

    /** @returns {number|null} the new bitrate, or null when it should stay put. */
    observe(backlog, now = Date.now()) {
      if (backlog > calmAt) {
        calmSince = null;
      } else if (calmSince === null) {
        calmSince = now;
      }

      if (now - changedAt < holdMs) {
        return null;
      }

      if (backlog >= stepDownAt && level < ladder.length - 1) {
        level++;
        changedAt = now;
        return ladder[level];
      }

      if (level > 0 && calmSince !== null && now - calmSince >= stepUpAfterMs) {
        level--;
        changedAt = now;
        calmSince = now;
        return ladder[level];
      }

      return null;
    },
  };
}

module.exports = { LADDER, createBitrateController };
