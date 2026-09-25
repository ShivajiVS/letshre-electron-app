/**
 * The parts of the interview lockdown the window can't hold by itself: on
 * Windows the agent blocks system keys, touchpad gestures and focus changes;
 * on macOS the app takes focus back whenever it loses it.
 */

"use strict";

const { app } = require("electron");
const { sendAgentCommand } = require("./agentManager");
const { CODE } = require("../shared/violationCodes");
const { getThreatDisplayName } = require("../shared/blocklist");
const logger = require("./logger");

const POLL_MS = 500;
const START_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 1500;

/** @type {{win: Electron.BrowserWindow, onViolation: Function, timer: any, agentOn: boolean, busy: boolean, onResign?: Function} | null} */
let current = null;

function nativeHandle(win) {
  const buf = win.getNativeWindowHandle();
  return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

function report(state, event) {
  if (event?.type === "focus_lost") {
    const name = event.process ? getThreatDisplayName(event) : "";
    state.onViolation(`Left the interview window${name ? `: ${name}` : ""}`, "high", {
      code: CODE.FOCUS_LOST,
      apps: name ? [name] : [],
    });
    logger.warn(`[lockdown] focus taken by ${event.process || "another window"}`);
  } else if (event?.type === "virtual_desktop") {
    state.onViolation("Switched to another virtual desktop", "high", {
      code: CODE.VIRTUAL_DESKTOP,
    });
    logger.warn("[lockdown] interview window left the current virtual desktop");
  }
}

async function poll(state) {
  if (current !== state || state.busy || state.win.isDestroyed()) {
    return;
  }
  state.busy = true;
  try {
    await tick(state);
  } finally {
    state.busy = false;
  }
}

async function tick(state) {
  if (!state.agentOn) {
    const res = await sendAgentCommand("lockdown_start", START_TIMEOUT_MS, {
      hwnd: nativeHandle(state.win),
      pid: process.pid,
    });
    if (res?.active) {
      state.agentOn = true;
      logger.info(
        `[lockdown] agent lockdown on (keys hooked: ${res.keys_hooked}, touchpad locked: ${res.touchpad_locked})`
      );
    }
    return;
  }
  const res = await sendAgentCommand("lockdown_poll");
  if (!res || current !== state) {
    return;
  }
  // A restarted agent has forgotten the lockdown, so the next tick turns it back on.
  if (res.active === false) {
    state.agentOn = false;
    return;
  }
  for (const event of res.events || []) {
    report(state, event);
  }
}

function startMac(state) {
  state.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  state.onResign = () => {
    if (current !== state || state.win.isDestroyed()) {
      return;
    }
    app.focus({ steal: true });
    state.win.show();
    state.win.focus();
    state.onViolation("Left the interview window", "high", { code: CODE.FOCUS_LOST });
  };
  app.on("did-resign-active", state.onResign);
}

/**
 * @param {Electron.BrowserWindow} win - the locked interview window
 * @param {(event: string, severity: string, meta: object) => void} onViolation
 */
function start(win, onViolation) {
  stop();
  const state = { win, onViolation, timer: null, agentOn: false, busy: false };
  current = state;
  if (process.platform === "win32") {
    state.timer = setInterval(() => {
      poll(state).catch((err) => logger.warn("[lockdown] agent poll failed:", err.message));
    }, POLL_MS);
    poll(state).catch(() => {});
  } else if (process.platform === "darwin") {
    startMac(state);
  }
}

/** Resolves once the agent has let go, so the touchpad is restored before the agent is killed. */
function stop() {
  const state = current;
  current = null;
  if (!state) {
    return Promise.resolve();
  }
  clearInterval(state.timer);
  if (state.onResign) {
    app.removeListener("did-resign-active", state.onResign);
    if (!state.win.isDestroyed()) {
      state.win.setVisibleOnAllWorkspaces(false);
    }
  }
  if (process.platform !== "win32") {
    return Promise.resolve();
  }
  return sendAgentCommand("lockdown_stop", STOP_TIMEOUT_MS).then(() => {});
}

module.exports = { start, stop, _internal: { report, nativeHandle } };
