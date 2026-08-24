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

const { app, globalShortcut, desktopCapturer, session, dialog } = require("electron");
const logger = require("./logger");
const { killAgent } = require("./agentManager");
const { createWindow, getWindow, getIsInterviewActive } = require("./windowManager");
const { registerIpcHandlers } = require("./ipcHandlers");
const { applyArgvDeepLink } = require("./protocolHandler");
const updater = require("./updater");
const startDetection = require("../detector/systemChecks");
const authManager = require("./authManager");
const { SCOPE, isFrameAllowed, isUrlOriginAllowed } = require("./ipcScope");

// Screen share and getUserMedia are legitimately requested from two places:
// local file:// pages (permissions.html probes screen/camera/mic during
// preflight; identity-verification.html probes camera/mic) and the interview
// origin, in case the SPA ever requests media directly instead of going
// through the hidden recorder window (which uses desktopCapturer +
// chromeMediaSourceId and never goes through either handler below). Nothing
// else in this app calls either API, so every other origin is refused.
function isMediaFrameAllowed(frame) {
  return isFrameAllowed(SCOPE.LOCAL, frame) || isFrameAllowed(SCOPE.INTERVIEW, frame);
}

function isMediaUrlAllowed(url) {
  return isUrlOriginAllowed(SCOPE.LOCAL, url) || isUrlOriginAllowed(SCOPE.INTERVIEW, url);
}

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

  // 6. Configure screen capture to allow interview webcam/screen share.
  // Previously granted sources[0] to ANY requester with no origin check at
  // all — bounded in practice only by the navigation guard, but that guard
  // protects navigation, not getDisplayMedia() calls from whatever page is
  // currently loaded. Now refuses any frame that isn't local or the
  // interview origin before ever calling desktopCapturer.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isMediaFrameAllowed(request.frame)) {
      logger.warn(
        `[app] screen capture denied — untrusted origin: ${request.frame ? request.frame.origin : "(no frame)"}`
      );
      callback({ video: null });
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources.length ? sources[0] : null });
    } catch (err) {
      logger.warn("[app] screen capture handler error:", err.message);
      callback({ video: null });
    }
  });

  // 6b. No permission handler existed at all before this — camera, mic,
  // geolocation, notifications, and clipboard-read all took Electron's
  // defaults for whatever page happened to request them. Explicitly deny
  // everything except the two permissions the local preflight/identity pages
  // actually use, and only from an origin allowed to use them.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const isMediaPermission = permission === "media" || permission === "display-capture";
      const allowed =
        isMediaPermission &&
        details.isMainFrame !== false &&
        isMediaUrlAllowed(details.requestingUrl);
      if (!allowed) {
        logger.warn(
          `[app] permission "${permission}" denied for ${details.requestingUrl || "(no url)"}`
        );
      }
      callback(allowed);
    }
  );

  // 7. Auto-updater — initialised LAST so the window exists for early events.
  //    Interview-safe: checks/installs are gated on interview state internally.
  updater.init();
}

/**
 * Last-resort handlers for errors Electron would otherwise let crash the
 * process silently. Logged and swallowed rather than rethrown — for a
 * proctoring app, losing the whole interview session to an unrelated bug is
 * worse than continuing in a possibly-degraded state.
 */
function registerProcessErrorHandlers() {
  process.on("uncaughtException", (err) => {
    logger.error("[app] uncaughtException:", err.stack || err.message);
  });

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error("[app] unhandledRejection:", detail);
  });
}

/** Registers all top-level Electron app event listeners. */
function registerAppEvents() {
  registerProcessErrorHandlers();

  app
    .whenReady()
    .then(onReady)
    .catch((err) => {
      logger.error("[app] startup failed:", err.message);
      dialog.showErrorBox(
        "Failed to start",
        "LetsHyre Secure Interview could not start due to an unexpected error. Please restart the app. If this keeps happening, contact support."
      );
      app.quit();
    });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("activate", () => {
    if (getWindow() === null) {
      createWindow(safeViolation);
    }
  });

  // Renderer crashed/was killed (OOM, GPU crash, sandbox violation, etc.) —
  // the window is left blank with nothing running in it, so reload rather
  // than leave the candidate staring at a dead screen.
  app.on("render-process-gone", (_event, webContents, details) => {
    logger.error(
      `[app] render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`
    );

    if (details.reason === "clean-exit") {
      return;
    }

    const win = getWindow();
    if (win && !win.isDestroyed() && win.webContents === webContents) {
      dialog.showErrorBox(
        "Application Error",
        "The application ran into an unexpected error and needs to reload. If this happens again, please restart the app."
      );
      win.reload();
    }
  });

  // Child process (GPU, utility, etc.) died — usually not fatal to the main
  // window, so log only.
  app.on("child-process-gone", (_event, details) => {
    logger.error(
      `[app] child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    );
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    updater.dispose();
    killAgent();
  });
}

module.exports = { registerAppEvents, safeViolation };
