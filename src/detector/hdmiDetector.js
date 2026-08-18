"use strict";

// Uses Electron's native `screen` API rather than shelling out to PowerShell
// (WmiMonitorID) — the old probe was slow, missed USB-C/DisplayLink monitors,
// and silently fail-opened to "zero monitors" on any error.
const electron = require("electron");

/**
 * Detects whether more than one active display is connected.
 * Returns a Promise to keep the call-site signature identical to the old
 * spawn-based implementation (callers `await` it).
 *
 * @returns {Promise<{ detected: boolean, status: string, monitors: string[], reason: string }>}
 */
function detectHDMIWindows() {
  try {
    // Accessed lazily — the screen module must not be touched before app `ready`.
    const displays = electron.screen.getAllDisplays();
    const count = displays.length;
    const isExternal = count > 1;

    // Human-readable monitor descriptors for audit / debugging.
    const monitors = displays.map(
      (d) =>
        `display#${d.id}${d.internal ? " (internal)" : " (external)"} ` +
        `${d.size.width}x${d.size.height}@${d.scaleFactor}x`
    );

    return Promise.resolve({
      detected: isExternal,
      status: isExternal ? "violation" : "clear",
      monitors,
      reason: isExternal
        ? `Multiple displays detected (${count} active) — disconnect external monitors`
        : "",
    });
  } catch (err) {
    // The screen module is only unavailable before app `ready`; during an
    // active session this should never throw. Report it as indeterminate so
    // the caller's fail-closed policy can decide what to do — never fail-open.
    return Promise.resolve({
      detected: false,
      status: "indeterminate",
      monitors: [],
      reason: `Display probe failed: ${err.message}`,
    });
  }
}

module.exports = { detectHDMIWindows };
