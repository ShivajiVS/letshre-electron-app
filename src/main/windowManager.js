/**
 * src/main/windowManager.js
 * ─────────────────────────
 * Owns the full BrowserWindow lifecycle:
 *   - Window creation and configuration
 *   - Security hardening (input lockdown, navigation guardrails, CSP)
 *   - Interview lockdown mode (kiosk, always-on-top)
 *   - Window event protections (minimize, close)
 */

"use strict";

const path = require("path");
const { app, BrowserWindow, session } = require("electron");
const logger = require("./logger");
const { INTERVIEW_BASE_URL } = require("../shared/constants");

/** @type {BrowserWindow | null} */
let win = null;

/** @type {boolean} */
let isInterviewActive = false;

// ─── Window Creation ─────────────────────────────────────────────────────────

/**
 * Creates and configures the main application window.
 * @param {(event: string, severity: string) => void} onViolation
 * @returns {BrowserWindow}
 */
function createWindow(onViolation) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../../preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // ADD-10: Explicit Electron security checklist hardening
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });

  win.maximize();
  win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  win.setMenuBarVisibility(false);

  // ADD-10: Block DevTools in production builds
  if (app.isPackaged) {
    win.webContents.on("devtools-opened", () => {
      win.webContents.closeDevTools();
      logger.warn("[window] DevTools open attempt blocked (packaged build)");
    });
  }

  _applyInputLockdown();
  _applyNavigationGuardrails();
  _applyWindowProtections(onViolation);
  _applyCSPHeaders();

  return win;
}

// ─── Interview Lockdown ──────────────────────────────────────────────────────

/**
 * Activates full interview lockdown mode.
 * Must be called after the interview URL has been loaded.
 * @param {string} interviewUrl
 */
function lockdownForInterview(interviewUrl) {
  if (!win) {return;}
  isInterviewActive = true;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setKiosk(true);
  win.setFullScreen(true);
  win.setMinimizable(false);

  win.loadURL(interviewUrl);
  logger.info("[window] lockdown activated — navigating to interview");
}

// ─── Internal Hardening ──────────────────────────────────────────────────────

/** Blocks DevTools, Ctrl+Shift+I, Meta+Alt+I, and Alt+F4 key combos. */
function _applyInputLockdown() {
  win.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.meta && input.alt && input.key === "I");

    // Alt+F4 is only blocked during an active interview session.
    // During requirements/preflight the user may need to Alt+F4 out of this
    // app temporarily to manually close other windows before rescanning.
    const isAltF4 = input.alt && input.key === "F4" && isInterviewActive;

    if (isDevTools || isAltF4) {
      event.preventDefault();
    }
  });
}

/**
 * Prevents navigation to any URL outside the interview domain or local files.
 * Also blocks all window.open() calls.
 */
function _applyNavigationGuardrails() {
  win.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith(INTERVIEW_BASE_URL) &&
      !url.startsWith("file://")
    ) {
      logger.warn("[window] blocked navigation to:", url);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Prevents minimize and close during an active interview session. */
function _applyWindowProtections(onViolation) {
  win.on("minimize", (e) => {
    if (!isInterviewActive) {return;}
    e.preventDefault();
    win.restore();
    win.focus();
    onViolation("Window minimize attempt", "high");
  });

  win.on("close", (e) => {
    if (isInterviewActive) {
      e.preventDefault(); // block the close — window must stay open during interview
      onViolation("Attempt to close interview window", "high");
    }
  });
}

/**
 * Sets a Content-Security-Policy response header on all requests
 * served through the default session.
 */
function _applyCSPHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' https://interview.letshyre.com https://api.letshyre.com; " +
            "script-src 'self' https://cdn.tailwindcss.com https://fonts.googleapis.com 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; " +
            "font-src 'self' https://fonts.gstatic.com data:; " +
            "img-src 'self' data: blob:; " +
            "connect-src 'self' https://api.letshyre.com http://127.0.0.1:9999;",
        ],
      },
    });
  });
}

// ─── Accessors ───────────────────────────────────────────────────────────────

/** Returns the current BrowserWindow instance (may be null). */
function getWindow() {
  return win;
}

/** Returns whether an interview session is currently active. */
function getIsInterviewActive() {
  return isInterviewActive;
}

/**
 * Minimizes the window — safe to call during requirements/preflight phase.
 * During active interview the window lock prevents minimize via the close handler,
 * so this function is effectively a no-op if somehow invoked then.
 */
function minimizeWindow() {
  if (win && !isInterviewActive) {
    win.minimize();
  }
}

module.exports = {
  createWindow,
  lockdownForInterview,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
};
