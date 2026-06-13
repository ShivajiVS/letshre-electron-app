/**
 * src/main/app.js
 * ───────────────
 * Electron app lifecycle manager.
 *
 * Handles:
 *   - app.whenReady()  → auto-updater, agent spawn, IPC registration, window
 *   - window-all-closed
 *   - activate (macOS re-open)
 *   - will-quit         → cleanup (shortcuts, agent)
 */

"use strict";

const { app, globalShortcut, desktopCapturer, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const logger = require("./logger");
const { spawnAgent, waitForAgent, killAgent } = require("./agentManager");
const { createWindow, getWindow, getIsInterviewActive } = require("./windowManager");
const { registerIpcHandlers } = require("./ipcHandlers");
const { applyArgvDeepLink } = require("./protocolHandler");
const { getCurrentAccessToken } = require("./protocolHandler");
const startDetection = require("../detector/systemChecks");

/**
 * Wires up the violation callback and forwards it to the detection module.
 */
function safeViolation(event, severity) {
  try {
    const win = getWindow();
    const token = getCurrentAccessToken();
    if (startDetection.sendViolation && win) {
      startDetection.sendViolation(win, event, severity, token);
    }
  } catch (err) {
    logger.error("[app] violation telemetry failed:", err.message);
  }
}

/**
 * Initialises the application once Electron is ready.
 * Order: updater → agent → IPC → window → shortcuts → screen capture.
 */
async function onReady() {
  // 1. Auto-updater
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    logger.warn("[app] auto-updater check failed:", err.message);
  }

  // 2. Spawn security agent
  spawnAgent();
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
}

/** Registers all top-level Electron app event listeners. */
function registerAppEvents() {
  app.whenReady().then(onReady).catch((err) => {
    logger.error("[app] startup failed:", err.message);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.isQuiting = true;
      app.quit();
    }
  });

  app.on("activate", () => {
    if (getWindow() === null) {
      createWindow(safeViolation);
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    killAgent();
  });
}

module.exports = { registerAppEvents, safeViolation };
