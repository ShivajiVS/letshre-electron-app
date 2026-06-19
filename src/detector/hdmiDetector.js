/**
 * src/detector/hdmiDetector.js
 * ────────────────────────────
 * External-display / HDMI detection.
 *
 * Phase 0: rewritten to use Electron's native `screen` API instead of
 * spawning `powershell.exe` (WmiMonitorID / Win32_VideoController) on every
 * scan tick. The previous approach was the single biggest source of flaky
 * detection:
 *   - PowerShell cold-start (200–700 ms) timed out under load
 *   - any error path resolved to "zero monitors" → silent fail-OPEN
 *   - WmiMonitorID missed USB-C / DisplayLink external displays
 *
 * `screen.getAllDisplays()` is native, synchronous, instant, and reflects the
 * same physical displays the OS compositor sees — cross-platform (Win/Mac/Linux).
 *
 * Contract (shared across detectors):
 *   status: "clear" | "violation" | "indeterminate"
 *   detected: boolean  (true ⇢ status "violation")
 */

"use strict";

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
