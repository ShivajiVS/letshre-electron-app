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
const { app, BrowserWindow, session, dialog, nativeImage } = require("electron");
const logger = require("./logger");
const appState = require("./appState");
const { INTERVIEW_BASE_URL, IPC } = require("../shared/constants");

/** @type {BrowserWindow | null} */
let win = null;

/** @type {boolean} */
let isInterviewActive = false;

/** @type {string | null} — base64 JPEG captured during identity verification, injected into the interview SPA sessionStorage on dom-ready */
let _candidatePhotoBase64 = null;

// ─── Window Creation ─────────────────────────────────────────────────────────

/**
 * Creates and configures the main application window.
 * @param {(event: string, severity: string) => void} onViolation
 * @param {'login'|'dashboard'} [startPage='login'] - Which page to open on launch.
 * @returns {BrowserWindow}
 */
function createWindow(onViolation, startPage = "login") {
  // Prevent duplicate window creation
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    title: "",
    icon: nativeImage.createEmpty(),
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

  // win.webContents.openDevTools({ mode: "right" }); // DEBUG — remove before shipping

  const pageFiles = { login: "login.html", dashboard: "dashboard.html" };
  const pageFile = pageFiles[startPage] || pageFiles.login;
  win.loadFile(path.join(__dirname, "../../assets", pageFile));

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
  if (!win) {
    return;
  }
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
  if (!win || win.isDestroyed()) {
    return;
  }

  isInterviewActive = false;
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);

  // Retry pushing the violation via IPC — by T+8s the session will have loaded
  // and the interview page's buffered-violation flush will show the modal.
  try {
    win.webContents.send(IPC.PUSH_VIOLATION, {
      event: String(reason).slice(0, 200),
      severity: "high",
      count: 1,
      isHardBlock: true,
      source: "electron",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn("[window] violation IPC retry failed:", err.message);
  }

  logger.warn(`[window] self-enforced violation — IPC retry sent: ${reason}`);
}

// ─── Interview Lockdown ──────────────────────────────────────────────────

/**
 * Activates full interview lockdown mode and injects auth tokens + candidate
 * photo into the SPA's sessionStorage before React boots.
 *
 * Injection uses webContents.executeJavaScript() on the dom-ready event, which
 * fires after the HTML is parsed but before module scripts execute — no race.
 *
 * @param {string} interviewUrl
 * @param {{ accessToken: string|null, refreshToken: string|null } | null} tokens
 * @param {{ is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] } | null} roleSelection
 */
function lockdownForInterview(interviewUrl, tokens = null, roleSelection = null) {
  if (!win) {
    return;
  }
  isInterviewActive = true;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setKiosk(true);
  win.setFullScreen(true);
  win.setMinimizable(false);

  const hasTokens = tokens?.accessToken || tokens?.refreshToken;
  const hasPhoto = Boolean(_candidatePhotoBase64);
  const hasRole = Boolean(roleSelection);

  if (hasTokens || hasPhoto || hasRole) {
    win.webContents.once("dom-ready", () => {
      const statements = [];
      if (tokens?.accessToken) {
        statements.push(`sessionStorage.setItem('ac', ${JSON.stringify(tokens.accessToken)});`);
      }
      if (tokens?.refreshToken) {
        statements.push(`sessionStorage.setItem('rc', ${JSON.stringify(tokens.refreshToken)});`);
      }
      if (_candidatePhotoBase64) {
        statements.push(
          `sessionStorage.setItem('candidate_photo', ${JSON.stringify(_candidatePhotoBase64)});`
        );
      }
      if (roleSelection) {
        // JSON-encode twice: once for the stored value, once to embed it as a
        // string literal inside the injected executeJavaScript() statement.
        statements.push(
          `sessionStorage.setItem('role_selection', ${JSON.stringify(JSON.stringify(roleSelection))});`
        );
      }

      if (statements.length > 0) {
        win.webContents
          .executeJavaScript(statements.join("\n"))
          .catch((err) => logger.warn("[window] sessionStorage injection failed:", err.message));
      }
    });
  }

  win.loadURL(interviewUrl);
  logger.info("[window] lockdown activated — navigating to interview");
}

/**
 * Stores the base64 photo captured during identity verification so it can be
 * injected into the interview SPA sessionStorage on the next dom-ready event.
 * @param {string} dataUrl — base64 data URL ("data:image/jpeg;base64,…")
 */
function storeCandidatePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    logger.warn("[window] storeCandidatePhoto: invalid data URL, ignoring");
    return;
  }
  _candidatePhotoBase64 = dataUrl;
  logger.info("[window] candidate photo stored for interview injection");
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
            "img-src 'self' data: blob: https://api.letshyre.com; " +
            "media-src 'self' blob:; " +
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

/**
 * Navigates to the security-check (preflight) screen. Called after the user
 * picks "Take Interview" on the dashboard — the interview session tokens are
 * set first by the IPC handler. The preflight → permissions → lockdown →
 * interview flow is unchanged from here.
 */
function loadSecurityCheck() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  }
}

/**
 * Navigates to the permissions page. Called when the user clicks Proceed on
 * the preflight screen — all security checks have passed but the window is
 * NOT yet in kiosk/lockdown mode (the OS needs to show native permission
 * dialogs). Lockdown happens only after the user clicks Start Interview.
 */
function loadPermissionsPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/permissions.html"));
  }
}

/**
 * Navigates to the identity verification page. Called after all permissions
 * are granted — camera/mic/screen already approved by the OS.
 */
function loadIdentityVerificationPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/identity-verification.html"));
  }
}

/**
 * Navigates back to the dashboard. Used by the back button on the security
 * check page — does not clear the session, just shows the dashboard again.
 */
function loadDashboard() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/dashboard.html"));
  }
}

/**
 * Navigates to the role selection page. Called after identity verification
 * passes — candidate confirms or enters their role before interview lockdown.
 */
function loadRoleSelectionPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/role-selection.html"));
  }
}

/**
 * Navigates to the how-it-works page. Accessible from login and dashboard —
 * no auth required, purely informational.
 */
function loadHowItWorksPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/how-it-works.html"));
  }
}

module.exports = {
  createWindow,
  lockdownForInterview,
  storeCandidatePhoto,
  endInterview,
  enforceViolation,
  loadDashboard,
  loadSecurityCheck,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
};
