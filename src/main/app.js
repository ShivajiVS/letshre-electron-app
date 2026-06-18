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
const { autoUpdater } = require("electron-updater");
const logger = require("./logger");
const appState = require("./appState");
const { spawnAgent, waitForAgent, killAgent } = require("./agentManager");
const { createWindow, getWindow, getIsInterviewActive } = require("./windowManager");
const { registerIpcHandlers } = require("./ipcHandlers");
const { applyArgvDeepLink } = require("./protocolHandler");
const { getCurrentAccessToken } = require("./protocolHandler");
const { IPC } = require("../shared/constants");
const startDetection = require("../detector/systemChecks");

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
 * Wires up auto-updater events so the renderer can show an in-app banner.
 * ADD-01: Replaces the silent `checkForUpdatesAndNotify()` system notification.
 */
function setupAutoUpdater() {
  try {
    autoUpdater.on("update-available", (info) => {
      logger.info("[updater] update available:", info.version);
      getWindow()?.webContents.send(IPC.PUSH_UPDATE_AVAILABLE, { version: info.version });
    });

    autoUpdater.on("update-downloaded", (info) => {
      logger.info("[updater] update downloaded, ready to install:", info.version);
      getWindow()?.webContents.send(IPC.PUSH_UPDATE_DOWNLOADED, { version: info.version });
    });

    autoUpdater.on("error", (err) => {
      logger.warn("[updater] error:", err.message);
    });

    autoUpdater.checkForUpdates();
  } catch (err) {
    logger.warn("[app] auto-updater setup failed:", err.message);
  }
}

/**
 * Initialises the application once Electron is ready.
 * Order: logger → updater → agent → IPC → window → shortcuts → screen capture.
 */
async function onReady() {
  // 0. Initialise file logger now that userData path is available
  logger.init(app.getPath("userData"));

  // 1. Auto-updater with in-app notification events
  setupAutoUpdater();

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
    // Only quit if the user explicitly triggered quit (via quit button, Alt+F4 confirm, etc.)
    // During preflight, if the window is accidentally destroyed, recreate it instead of exiting.
    if (appState.isQuitting()) {
      app.quit();
    } else {
      // Window was destroyed unexpectedly — recreate it
      createWindow(safeViolation);
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
