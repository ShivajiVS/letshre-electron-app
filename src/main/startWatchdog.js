"use strict";

// Nothing but the candidate's word gets them out of a locked window, so if the
// site never starts the interview they're asked whether to keep waiting.
const STALL_AFTER_MS = 90_000;
const ASK_AGAIN_MS = 60_000;

/**
 * @param {{
 *   onStall: () => Promise<boolean>,
 *   stallAfterMs?: number,
 *   askAgainMs?: number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} options onStall resolves true once the candidate has left
 */
function createStartWatchdog({
  onStall,
  stallAfterMs = STALL_AFTER_MS,
  askAgainMs = ASK_AGAIN_MS,
  timers = { setTimeout, clearTimeout },
}) {
  let timer = null;
  let armed = false;
  let live = false;

  const clear = () => {
    timers.clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms) => {
    timer = timers.setTimeout(fire, ms);
    timer?.unref?.();
  };

  async function fire() {
    timer = null;
    if (!armed || live) {
      return;
    }
    let left = false;
    try {
      left = await onStall();
    } catch {
      left = false;
    }
    if (armed && !live && !left) {
      schedule(askAgainMs);
    }
  }

  return {
    arm() {
      clear();
      armed = true;
      live = false;
      schedule(stallAfterMs);
    },
    markLive() {
      live = true;
      clear();
    },
    disarm() {
      armed = false;
      clear();
    },
    isLive: () => live,
  };
}

module.exports = { createStartWatchdog, STALL_AFTER_MS, ASK_AGAIN_MS };
