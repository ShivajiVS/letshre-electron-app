"use strict";

const ALWAYS_ON_TOP_LEVEL = "screen-saver";
const WATCHDOG_MS = 1000;
const SETTLE_MS = 300;

/** Everything about the window that must hold while an interview is live. */
function _lostProperties(win) {
  const lost = [];
  if (win.isMinimized()) {
    lost.push("minimized");
  }
  if (!win.isFullScreen()) {
    lost.push("fullscreen");
  }
  if (!win.isKiosk()) {
    lost.push("kiosk");
  }
  if (!win.isAlwaysOnTop()) {
    lost.push("always-on-top");
  }
  if (win.isMinimizable()) {
    lost.push("minimizable");
  }
  if (win.isMaximizable()) {
    lost.push("maximizable");
  }
  if (win.isResizable()) {
    lost.push("resizable");
  }
  return lost;
}

function applyLock(win) {
  if (win.isMinimized()) {
    win.restore();
  }
  win.setMinimizable(false);
  win.setMaximizable(false);
  win.setResizable(false);
  win.setMovable(false);
  // Fullscreen first: the transition can drop always-on-top if it was set before.
  if (!win.isKiosk()) {
    win.setKiosk(true);
  }
  if (!win.isFullScreen()) {
    win.setFullScreen(true);
  }
  win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
}

function releaseLock(win) {
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);
  win.setMaximizable(true);
  win.setResizable(true);
  win.setMovable(true);
}

/**
 * Holds the interview lockdown for as long as it runs. The lock used to be set
 * once and never checked again, so anything that knocked a property off (a
 * fullscreen transition racing always-on-top, Win+Down, a taskbar click) left
 * the window unlocked for the rest of the interview.
 *
 * @param {import("electron").BrowserWindow} win
 * @param {{ onViolation: (event: string, severity: string) => void, log: { warn: Function } }} deps
 */
function createLockdownGuard(win, { onViolation, log, watchdogMs = WATCHDOG_MS }) {
  let watchdog = null;
  let settleTimer = null;
  let lastLost = "";
  const listeners = [];

  const on = (event, handler) => {
    win.on(event, handler);
    listeners.push([event, handler]);
  };

  /** Re-applies the lock if anything drifted. Returns what had been lost. */
  const check = () => {
    if (win.isDestroyed()) {
      stop();
      return [];
    }
    const lost = _lostProperties(win);
    const signature = lost.join(",");
    if (lost.length > 0) {
      if (signature !== lastLost) {
        log.warn(`[lockdown] window lost ${signature} — re-applying`);
      }
      applyLock(win);
    }
    lastLost = signature;
    return lost;
  };

  const start = () => {
    on("minimize", (e) => {
      e.preventDefault();
      win.restore();
      check();
      win.focus();
      onViolation("Window minimize attempt", "high");
    });
    on("leave-full-screen", () => {
      check();
      onViolation("Fullscreen exit attempt", "medium");
    });
    // Windows can drop always-on-top a moment after the transition reports done.
    on("enter-full-screen", () => {
      win.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
      settleTimer = setTimeout(check, SETTLE_MS);
    });
    on("always-on-top-changed", (_e, isOnTop) => {
      if (!isOnTop) {
        check();
      }
    });
    on("maximize", check);
    on("unmaximize", check);
    on("restore", check);
    on("blur", () => {
      check();
      win.moveTop();
      win.focus();
    });
    on("closed", stop);

    applyLock(win);
    watchdog = setInterval(check, watchdogMs);
  };

  function stop() {
    clearTimeout(settleTimer);
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
    if (!win.isDestroyed()) {
      for (const [event, handler] of listeners) {
        win.removeListener(event, handler);
      }
    }
    listeners.length = 0;
  }

  return { start, stop, check };
}

module.exports = { ALWAYS_ON_TOP_LEVEL, applyLock, releaseLock, createLockdownGuard };
