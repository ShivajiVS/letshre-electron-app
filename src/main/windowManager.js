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
const { app, BrowserWindow, session, dialog } = require("electron");
const logger = require("./logger");
const appState = require("./appState");
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
  // Prevent duplicate window creation
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

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

  // Clean up reference when window is destroyed
  win.on("closed", () => {
    win = null;
  });

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

// ─── Interview End ─────────────────────────────────────────────────────

/**
 * Called when the interview session ends (signal received from interview.letshyre.com).
 * Clears the lockdown flag and restores normal window behaviour so the candidate
 * can close or minimise the app once the interview is fully complete.
 *
 * @param {string} reason - e.g. "completed", "auto-submitted", "terminated", "expired"
 */
function endInterview(reason) {
  if (!win) { return; }
  if (!isInterviewActive) {
    logger.info("[window] endInterview called but interview was already inactive — skipping");
    return;
  }

  isInterviewActive = false;

  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);

  logger.info(`[window] interview ended (reason: ${reason}) — window restrictions lifted`);
}

// ─── Self-Enforced Violation ─────────────────────────────────────────────

/**
 * Electron self-enforcement of a hard-block (failsafe).
 *
 * Invoked when a hard-block violation was pushed to the website but the session
 * is still active after the grace window — i.e. the renderer dropped the event
 * or failed to terminate. Lifts the interview lockdown so the candidate can read
 * the screen and act, then navigates to the local violation page (which offers
 * Quit / Re-check). This guarantees a hard-block has a consequence even when the
 * website doesn't handle it.
 *
 * @param {string} reason
 */
function enforceViolation(reason) {
  if (!win || win.isDestroyed()) { return; }

  isInterviewActive = false;
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);

  win.loadFile(path.join(__dirname, "../../assets/violation.html"), {
    query: { reason: String(reason).slice(0, 200) },
  });

  logger.warn(`[window] self-enforced violation screen — reason: ${reason}`);
}

// ─── Interview Lockdown ──────────────────────────────────────────────────

/**
 * Activates full interview lockdown mode.
 * Must be called after the interview URL has been loaded.
 * @param {string} interviewUrl
 */
function lockdownForInterview(interviewUrl) {
  if (!win) {
    return;
  }
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
    if (!url.startsWith(INTERVIEW_BASE_URL) && !url.startsWith("file://")) {
      logger.warn("[window] blocked navigation to:", url);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Prevents minimize and close during an active interview session. */
function _applyWindowProtections(onViolation) {
  win.on("minimize", (e) => {
    if (!isInterviewActive) {
      return;
    }
    e.preventDefault();
    win.restore();
    win.focus();
    onViolation("Window minimize attempt", "high");
  });

  win.on("close", (e) => {
    if (!isInterviewActive) {
      appState.setQuitting();
      return;
    } // preflight — allow close freely

    // Interview is active: show a native confirmation dialog instead of hard-blocking.
    // This allows the user to close the app if they genuinely need to,
    // while still logging a violation if they cancel.
    e.preventDefault();

    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Exit Interview", "Cancel"],
      defaultId: 1, // default highlight: Cancel (safer)
      cancelId: 1,
      title: "Exit Interview?",
      message: "Are you sure you want to exit?",
      detail:
        "Closing the app during an active interview session will be recorded and may be flagged to the interviewer.",
      noLink: true,
    });

    if (choice === 0) {
      // User confirmed — quit cleanly
      logger.warn("[window] user confirmed interview exit via close dialog");
      isInterviewActive = false;
      app.quit();
    } else {
      // User cancelled — log the attempt
      logger.warn("[window] user dismissed close dialog during interview");
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
    // Only enforce a strict CSP on local pages (preflight.html, etc.).
    // interview.letshyre.com manages its own server-side CSP —
    // overriding it here blocks images, API calls, and other resources
    // that work fine in a regular browser.
    if (!details.url.startsWith("file://")) {
      return callback({ responseHeaders: details.responseHeaders });
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; " +
            "font-src 'self' https://fonts.gstatic.com data:; " +
            "img-src 'self' data: blob: https://api.letshyre.com;" +
            "connect-src 'self' http://127.0.0.1:9999;",
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
  endInterview,
  enforceViolation,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
};
