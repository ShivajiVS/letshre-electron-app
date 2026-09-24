"use strict";

const electron = require("electron");

/**
 * Detects whether more than one active display is connected.
 * @returns {Promise<{ detected: boolean, status: string, count: number, monitors: string[], reason: string }>}
 */
function detectHDMIWindows() {
  try {
    // Read lazily: the screen module can't be touched before app `ready`.
    const displays = electron.screen.getAllDisplays();
    const count = displays.length;
    const isExternal = count > 1;

    const monitors = displays.map(
      (d) =>
        `display#${d.id}${d.internal ? " (internal)" : " (external)"} ` +
        `${d.size.width}x${d.size.height}@${d.scaleFactor}x`
    );

    return Promise.resolve({
      detected: isExternal,
      status: isExternal ? "violation" : "clear",
      count,
      monitors,
      reason: isExternal
        ? `Multiple displays detected (${count} active) — disconnect external monitors`
        : "",
    });
  } catch (err) {
    // Indeterminate, never "no external display": the caller fails closed on it.
    return Promise.resolve({
      detected: false,
      status: "indeterminate",
      monitors: [],
      reason: `Display probe failed: ${err.message}`,
    });
  }
}

module.exports = { detectHDMIWindows };
