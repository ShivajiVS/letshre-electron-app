/**
 * Electron app lifecycle manager:
 * Handles:
 *   - app.whenReady()  → logger init, auth restore, IPC, window, auto-updater
 *   - window-all-closed
 *   - activate (macOS re-open)
 *   - will-quit         → cleanup (shortcuts, agent)
 *
 * The security agent is NOT spawned here — it is scoped to the security-check →
 * interview window (started via ensureAgent() when the preflight page opens,
 * stopped on interview completion / return to dashboard / app quit).
 */

"use strict";

const { app, globalShortcut, desktopCapturer, session } = require("electron");
const logger = require("./logger");
const { killAgent } = require("./agentManager");
const { createWindow, getWindow, getIsInterviewActive } = require("./windowManager");
const { registerIpcHandlers } = require("./ipcHandlers");
const { applyArgvDeepLink } = require("./protocolHandler");
const updater = require("./updater");
const startDetection = require("../detector/systemChecks");
const authManager = require("./authManager");

function safeViolation(event, severity) {
  try {
    const win = getWindow();
    if (startDetection.sendViolation && win) {
      startDetection.sendViolation(win, event, severity);
    }
  } catch (err) {
    logger.error("[app] violation push failed:", err.message);
  }
}

/**
 * Initialises the application once Electron is ready.
 * Order: logger → auth restore → IPC → window → shortcuts → screen capture → updater.
 * The security agent is started later, when the security-check page opens.
 */
async function onReady() {
  // 0. Initialise file logger now that userData path is available
  logger.init(app.getPath("userData"));

  // 0b. Restore persisted auth session (safeStorage is ready after app.whenReady)
  authManager.init();

  // 1. Verify the restored session. The security agent is intentionally NOT
  //    spawned here — it is scoped to the security-check → interview window.
  const sessionResult = await authManager.verifySession();

  if (sessionResult.valid) {
    logger.info(
      `[app] startup auth: valid session${sessionResult.offline ? " (offline grace)" : ""}`
    );
  } else {
    logger.info(
      `[app] startup auth: no valid session (${sessionResult.reason}) — routing to login`
    );
  }

  // 2. Register all IPC channels
  registerIpcHandlers();

  // 3. Apply Windows argv deep-link (must run before createWindow)
  if (process.platform === "win32") {
    applyArgvDeepLink(process.argv);
  }

  // 4. Create the main window — open dashboard directly if session is valid,
  //    otherwise start at login.
  const startPage = sessionResult.valid ? "dashboard" : "login";
  createWindow(safeViolation, startPage);

  // 5. Register OS-level Alt+F4 global shortcut
  globalShortcut.register("Alt+F4", () => {
    if (getIsInterviewActive()) {
      safeViolation("Attempted OS level Alt+F4 kill string", "high");
      setTimeout(() => app.quit(), 500);
    } else {
      app.quit();
    }
  });

  // 6. Configure screen capture to allow interview webcam/screen share
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources.length ? sources[0] : null });
    } catch (err) {
      logger.warn("[app] screen capture handler error:", err.message);
      callback({ video: null });
    }
  });

  // 7. Auto-updater — initialised LAST so the window exists for early events.
  //    Interview-safe: checks/installs are gated on interview state internally.
  updater.init();
}

/** Registers all top-level Electron app event listeners. */
function registerAppEvents() {
  app
    .whenReady()
    .then(onReady)
    .catch((err) => {
      logger.error("[app] startup failed:", err.message);
    });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("activate", () => {
    if (getWindow() === null) {
      createWindow(safeViolation);
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    updater.dispose();
    killAgent();
  });
}

module.exports = { registerAppEvents, safeViolation };
