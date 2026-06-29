/**
 * src/main/app.js
 * ───────────────
 * Electron app lifecycle manager.
 *
 * Handles:
 *   - app.whenReady()  → logger init, auto-updater, agent spawn, IPC, window
 *   - window-all-closed
 *   - activate (macOS re-open)
 *   - will-quit         → cleanup (shortcuts, agent)
 */

"use strict";

const { app, globalShortcut, desktopCapturer, session } = require("electron");
const logger = require("./logger");
const { spawnAgent, waitForAgent, killAgent } = require("./agentManager");
const { createWindow, getWindow, getIsInterviewActive } = require("./windowManager");
const { registerIpcHandlers } = require("./ipcHandlers");
const { applyArgvDeepLink } = require("./protocolHandler");
const updater = require("./updater");
const startDetection = require("../detector/systemChecks");
const authManager = require("./authManager");

/**
 * Wires up the violation callback and forwards it to the detection module.
 */
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
 * Order: logger → agent → IPC → window → shortcuts → screen capture → updater.
 */
async function onReady() {
  // 0. Initialise file logger now that userData path is available
  logger.init(app.getPath("userData"));

  // 0b. Restore persisted auth session (safeStorage is ready after app.whenReady)
  authManager.init();

  // 1. Spawn security agent (kills stale orphans first)
  await spawnAgent();
  const agentReady = await waitForAgent();
  if (agentReady) {
    logger.info("[app] security agent ready ✅");
  } else {
    logger.warn("[app] agent not responding — continuing without deep detection");
  }

  // 3. Register all IPC channels
  registerIpcHandlers();

  // 4. Apply Windows argv deep-link (must run before createWindow)
  if (process.platform === "win32") {
    applyArgvDeepLink(process.argv);
  }

  // 5. Create the main window (passes violation callback for window events)
  createWindow(safeViolation);

  // 6. Register OS-level Alt+F4 global shortcut
  globalShortcut.register("Alt+F4", () => {
    if (getIsInterviewActive()) {
      safeViolation("Attempted OS level Alt+F4 kill string", "high");
      setTimeout(() => app.quit(), 500);
    } else {
      app.quit();
    }
  });

  // 7. Configure screen capture to allow interview webcam/screen share
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        callback({ video: sources.length ? sources[0] : null });
      } catch (err) {
        logger.warn("[app] screen capture handler error:", err.message);
        callback({ video: null });
      }
    }
  );

  // 8. Auto-updater — initialised LAST so the window exists for early events.
  //    Interview-safe: checks/installs are gated on interview state internally.
  updater.init();
}

/** Registers all top-level Electron app event listeners. */
function registerAppEvents() {
  app.whenReady().then(onReady).catch((err) => {
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
