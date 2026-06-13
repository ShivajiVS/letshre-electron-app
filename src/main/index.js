/**
 * src/main/index.js
 * ─────────────────
 * Main process entry point — intentionally thin.
 *
 * Responsibilities:
 *   1. Enforce single-instance lock
 *   2. Register the letshyre:// custom protocol
 *   3. Handle second-instance deep-links (Windows/Linux)
 *   4. Handle macOS open-url events
 *   5. Delegate everything else to app.js
 */

"use strict";

const path = require("path");
const { app } = require("electron");
const { registerAppEvents, safeViolation } = require("./app");
const { handleIncomingProtocol } = require("./protocolHandler");
const { getWindow, getIsInterviewActive } = require("./windowManager");
const { PROTOCOL_SCHEME } = require("../shared/constants");

// ─── Single Instance Lock ────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // A second instance was launched — quit immediately.
  app.isQuiting = true;
  app.quit();
} else {
  // Handle second instance activation (Windows / Linux deep-link).
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (url) {
      handleIncomingProtocol(
        url,
        getWindow(),
        getIsInterviewActive(),
        safeViolation
      );
    }
  });

  // ── Custom Protocol Registration ─────────────────────────────────────────

  if (process.defaultApp) {
    // Dev mode: register with explicit execPath + argv[1]
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(
        PROTOCOL_SCHEME,
        process.execPath,
        [path.resolve(process.argv[1])]
      );
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }

  // ── macOS Protocol Launch (open-url) ─────────────────────────────────────

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleIncomingProtocol(
      url,
      getWindow(),
      getIsInterviewActive(),
      safeViolation
    );
  });

  // ── Delegate App Lifecycle ────────────────────────────────────────────────

  registerAppEvents();
}
