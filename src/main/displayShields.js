/**
 * Kiosk mode only covers the display the interview is on, so every other
 * display gets a black window over it for the length of the interview. The
 * extra display is still reported; this just stops it being usable meanwhile.
 */

"use strict";

const { BrowserWindow, screen } = require("electron");
const { ALWAYS_ON_TOP_LEVEL } = require("./lockdownGuard");
const logger = require("./logger");

const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"];

let shields = [];
let interviewDisplayId = null;

function cover(display) {
  const shield = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: "#000000",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  shield.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
  if (process.platform === "darwin") {
    shield.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  shield.setBounds(display.bounds);
  shield.showInactive();
  return shield;
}

function clear() {
  for (const shield of shields) {
    if (!shield.isDestroyed()) {
      shield.destroy();
    }
  }
  shields = [];
}

function refresh() {
  clear();
  const others = screen.getAllDisplays().filter((d) => d.id !== interviewDisplayId);
  shields = others.map(cover);
  if (others.length > 0) {
    logger.info(`[lockdown] covered ${others.length} other display(s)`);
  }
}

/** @param {number} displayId - the display the interview window is on */
function start(displayId) {
  stop();
  interviewDisplayId = displayId;
  for (const event of DISPLAY_EVENTS) {
    screen.on(event, refresh);
  }
  refresh();
}

function stop() {
  if (interviewDisplayId === null) {
    return;
  }
  for (const event of DISPLAY_EVENTS) {
    screen.removeListener(event, refresh);
  }
  interviewDisplayId = null;
  clear();
}

module.exports = { start, stop, _internal: { count: () => shields.length } };
