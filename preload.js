/**
 * preload.js
 * ──────────
 * Renderer context bridge — runs in a sandboxed context before the page loads.
 *
 * NOTE: With sandbox:true, Node's require() is NOT available for local files.
 * Only require('electron') works. IPC channel names are therefore inlined here
 * directly (they mirror src/shared/constants.js IPC — keep them in sync).
 *
 * Security hardening (capture phase):
 *   - Blocks right-click context menu
 *   - Blocks copy/paste/view-source keyboard shortcuts
 *   - Blocks PrintScreen
 */

/* eslint-env browser */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// ─── IPC Channel Names (mirrors src/shared/constants.js IPC object) ───────────
// Cannot require() the shared file here due to sandbox:true restriction.
const IPC = {
  // App control
  QUIT_APP: "quit-app",
  RECHECK_SYSTEM: "recheck-system",

  // Auth
  AUTH_LOGIN: "auth-login",
  AUTH_LOGOUT: "auth-logout",
  GET_AUTH_USER: "get-auth-user",
  GET_CANDIDATE_PROFILE: "get-candidate-profile",

  // Permissions page: preflight Proceed → main loads permissions.html
  LOAD_PERMISSIONS_PAGE: "load-permissions-page",

  // Identity verification page
  LOAD_IDENTITY_VERIFICATION: "load-identity-verification",
  SUBMIT_VOICE_SAMPLE: "submit-voice-sample",
  SUBMIT_FACE_VERIFICATION: "submit-face-verification",

  // Role selection page
  LOAD_ROLE_SELECTION: "load-role-selection",
  SUBMIT_ROLE: "submit-role",

  // Back navigation
  LOAD_DASHBOARD: "load-dashboard",
  LOAD_SECURITY_CHECK: "load-security-check",
  LOAD_HOW_IT_WORKS: "load-how-it-works",

  // Image proxy: main fetches CDN image → base64 data URL (bypasses renderer CSP)
  FETCH_PROFILE_IMAGE: "fetch-profile-image",

  // Dashboard → security check
  START_INTERVIEW: "start-interview",

  // Preflight
  RUN_PREFLIGHT: "run-preflight-scans",

  // Interview flow
  PROCEED_TO_INTERVIEW: "proceed-to-interview",

  // Process management
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",
  KILL_BLOCKED_APP_ELEVATED: "kill-blocked-app-elevated",
  CAN_ELEVATE: "can-elevate",

  // Auto-updater — push events (main → renderer)
  PUSH_UPDATE_AVAILABLE: "push-update-available",
  PUSH_UPDATE_DOWNLOADED: "push-update-downloaded",
  PUSH_UPDATE_PROGRESS: "push-update-progress",
  PUSH_UPDATE_ERROR: "push-update-error",
  PUSH_UPDATE_STATE: "push-update-state",

  // Auto-updater — invoke (renderer → main)
  INSTALL_UPDATE: "install-update",
  GET_UPDATE_STATE: "get-update-state",

  // App version (renderer invoke → main)
  GET_APP_VERSION: "get-app-version",

  // Audit trail
  GET_AUDIT_LOG: "get-audit-log",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Per-step preflight progress push (main → renderer)
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push during active interview
  PUSH_VIOLATION: "push-violation",

  // Interview session end: website → main
  INTERVIEW_COMPLETE: "interview-complete",

  // Violation acknowledgement: website → main
  ACK_VIOLATION: "ack-violation",

  // App list (ADD-10)
  GET_APP_LIST: "get-app-list",

  // Pre-proceed watcher: main → renderer push — real-time blocked-app status
  PUSH_PRE_PROCEED_STATUS: "push-pre-proceed-status",

  // Identity verification → main: store captured photo for sessionStorage injection
  STORE_CANDIDATE_PHOTO: "store-candidate-photo",

  // Screen recording / proctoring
  PROCTORING_START: "proctoring-start",
  PROCTORING_STOP: "proctoring-stop",
  PUSH_PROCTORING_STARTED: "push-proctoring-started",
  PUSH_PROCTORING_ERROR: "push-proctoring-error",

  // Localization
  GET_LOCALE: "get-locale",
  SET_LOCALE: "set-locale",
  GET_TRANSLATIONS: "get-translations",
  GET_SUPPORTED_LOCALES: "get-supported-locales",
  LOCALE_CHANGED: "locale-changed",
};

// Hardened IPC wrapper — only whitelisted channels are allowed
const ALLOWED_SEND_CHANNELS = [
  IPC.QUIT_APP, IPC.RECHECK_SYSTEM, IPC.PROCEED_TO_INTERVIEW,
  IPC.INSTALL_UPDATE, IPC.MINIMIZE_WINDOW, IPC.START_INTERVIEW,
  IPC.INTERVIEW_COMPLETE, IPC.ACK_VIOLATION, IPC.LOAD_PERMISSIONS_PAGE,
  IPC.LOAD_IDENTITY_VERIFICATION, IPC.LOAD_ROLE_SELECTION,
  IPC.LOAD_DASHBOARD, IPC.LOAD_SECURITY_CHECK, IPC.LOAD_HOW_IT_WORKS,
  IPC.PROCTORING_STOP,
];

const ALLOWED_INVOKE_CHANNELS = [
  IPC.RUN_PREFLIGHT, IPC.KILL_BLOCKED_APP,
  IPC.KILL_ALL_BLOCKED_APPS, IPC.KILL_BLOCKED_APP_ELEVATED, IPC.CAN_ELEVATE,
  IPC.GET_AUDIT_LOG, IPC.GET_APP_LIST,
  IPC.GET_APP_VERSION, IPC.GET_UPDATE_STATE,
  IPC.AUTH_LOGIN, IPC.AUTH_LOGOUT, IPC.GET_AUTH_USER, IPC.GET_CANDIDATE_PROFILE,
  IPC.SUBMIT_VOICE_SAMPLE, IPC.SUBMIT_FACE_VERIFICATION,
  IPC.FETCH_PROFILE_IMAGE, IPC.SUBMIT_ROLE,
  IPC.STORE_CANDIDATE_PHOTO,
  IPC.PROCTORING_START,
  IPC.GET_LOCALE, IPC.SET_LOCALE, IPC.GET_TRANSLATIONS, IPC.GET_SUPPORTED_LOCALES,
];

const ALLOWED_RECEIVE_CHANNELS = [
  IPC.PUSH_UPDATE_AVAILABLE, IPC.PUSH_UPDATE_DOWNLOADED,
  IPC.PUSH_UPDATE_PROGRESS, IPC.PUSH_UPDATE_ERROR, IPC.PUSH_UPDATE_STATE,
  IPC.PUSH_WARNING, IPC.PREFLIGHT_PROGRESS, IPC.PUSH_VIOLATION,
  IPC.PUSH_PRE_PROCEED_STATUS,
  IPC.PUSH_PROCTORING_STARTED, IPC.PUSH_PROCTORING_ERROR,
  IPC.LOCALE_CHANGED,
];

function safeSend(channel, ...args) {
  if (ALLOWED_SEND_CHANNELS.includes(channel)) {
    ipcRenderer.send(channel, ...args);
  }
}

function safeInvoke(channel, ...args) {
  if (ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
  return Promise.reject(new Error(`Channel not allowed: ${channel}`));
}

function safeOn(channel, callback) {
  if (ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
    ipcRenderer.on(channel, callback);
  }
}

// ADD-02: Tracked handler reference so we can remove it on rescan without removeAllListeners.
// Module-level variable — one active preflight listener at a time.
let _preflightProgressHandler = null;

// Violation bridge: tracked handler so we can deregister cleanly on unmount.
let _violationHandler = null;

let _updateAvailableHandler = null;
let _updateDownloadedHandler = null;
let _updateProgressHandler = null;
let _updateErrorHandler = null;
let _updateStateHandler = null;
let _warningHandler = null;

// ─── Exposed API ─────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Auth ─────────────────────────────────────────────────────────────────────
  /**
   * Log in. Tokens stay in the main process; this resolves with display-safe
   * fields only. @returns {Promise<{success:boolean, message:string, user?:object}>}
   */
  login: (email, password) => safeInvoke(IPC.AUTH_LOGIN, { email, password }),

  /** Log out (clears the main-process session). */
  logout: () => safeInvoke(IPC.AUTH_LOGOUT),

  /** Get the logged-in user's display-safe fields (or null). */
  getAuthUser: () => safeInvoke(IPC.GET_AUTH_USER),

  /**
   * Fetch the full candidate profile from the API (name, photo, interview
   * attempts, phone, role). Performs automatic token refresh on 401.
   * Returns display-safe fields only — tokens never leave main.
   * @returns {Promise<{ success: boolean, data?: object, message?: string }>}
   */
  getCandidateProfile: () => safeInvoke(IPC.GET_CANDIDATE_PROFILE),

  /** Dashboard "Take Interview": hand the session to the security check. */
  startInterview: () => safeSend(IPC.START_INTERVIEW),

  /**
   * Preflight "Proceed": navigate to the permissions page.
   * The window is NOT locked down yet — the OS needs to present native
   * permission dialogs. Lockdown happens when the user clicks Start Interview.
   */
  loadPermissionsPage: () => safeSend(IPC.LOAD_PERMISSIONS_PAGE),

  /** Permissions "Start interview": navigate to identity verification. */
  loadIdentityVerification: () => safeSend(IPC.LOAD_IDENTITY_VERIFICATION),

  /** Identity verification "Begin Interview": navigate to role selection. */
  loadRoleSelection: () => safeSend(IPC.LOAD_ROLE_SELECTION),

  /** Open the how-it-works informational page (login and dashboard). */
  loadHowItWorks: () => safeSend(IPC.LOAD_HOW_IT_WORKS),

  /** Back: navigate to dashboard (from security check). */
  loadDashboard: () => safeSend(IPC.LOAD_DASHBOARD),

  /** Back: navigate to security check (from permissions page). */
  loadSecurityCheck: () => safeSend(IPC.LOAD_SECURITY_CHECK),

  /**
   * Submit a role string; main POSTs to skills_for_role API with Bearer token.
   * @param {string} role
   * @returns {Promise<{ ok: boolean, data?: { needs_clarification: boolean, suggestions?: string[], skills?: string[] }, error?: string }>}
   */
  submitRole: (role) => safeInvoke(IPC.SUBMIT_ROLE, role),

  /**
   * Fetch an external image via the main process and return it as a base64
   * data URL. Use this instead of img.src = url to avoid CSP violations when
   * the image is hosted on S3 / CDN domains not in the renderer's img-src.
   * @param {string} url
   * @returns {Promise<{ ok: boolean, dataUrl?: string, error?: string }>}
   */
  fetchProfileImage: (url) => safeInvoke(IPC.FETCH_PROFILE_IMAGE, url),

  /**
   * Submit a voice recording blob. The Uint8Array is sent to main which
   * handles the multipart POST with the Bearer token.
   * @param {Uint8Array} uint8Array
   * @param {string} mimeType
   * @param {{ locale?: string, statementText?: string }} [meta] — active locale
   *   and the exact attestation text shown, so backend STT/voice-match uses
   *   the right language model.
   */
  submitVoiceSample: (uint8Array, mimeType, meta) =>
    safeInvoke(IPC.SUBMIT_VOICE_SAMPLE, uint8Array, mimeType, meta),

  /**
   * Submit a captured photo (canvas dataURL) for face verification.
   * Main process decodes the base64, builds multipart, POSTs with Bearer token.
   * @param {string} dataUrl
   */
  submitFaceVerification: (dataUrl) =>
    safeInvoke(IPC.SUBMIT_FACE_VERIFICATION, dataUrl),

  /**
   * Store the verified photo from identity-verification.html in the main
   * process so it can be injected into the interview SPA sessionStorage before
   * React boots (via webContents.executeJavaScript on dom-ready).
   * @param {string} dataUrl — base64 data URL
   */
  storeCandidatePhoto: (dataUrl) =>
    safeInvoke(IPC.STORE_CANDIDATE_PHOTO, dataUrl),

  // ── App control ────────────────────────────────────────────────────────────
  /** Quit the application. */
  quitApp: () => safeSend(IPC.QUIT_APP),

  /** Reload the preflight screen and reset detection state. */
  recheckSystem: () => safeSend(IPC.RECHECK_SYSTEM),

  /**
   * Minimize the window so the user can manually close apps flagged by the
   * preflight scan. Only works during requirements/preflight — ignored during
   * active interview (window lock takes precedence).
   */
  minimizeWindow: () => safeSend(IPC.MINIMIZE_WINDOW),

  // ── Preflight ──────────────────────────────────────────────────────────────
  /** Run all preflight security scans and return combined results. */
  runPreflight: () => safeInvoke(IPC.RUN_PREFLIGHT),

  // ── Interview flow ─────────────────────────────────────────────────────────
  /** Activate interview lockdown mode and navigate to the interview URL.
   *  payload: { is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] } */
  proceedToInterview: (payload) => safeSend(IPC.PROCEED_TO_INTERVIEW, payload),

  // ── Process management ─────────────────────────────────────────────────────
  /**
   * Force-terminate a single blocked process.
   * @param {string} processName
   */
  killProcess: (processName) =>
    safeInvoke(IPC.KILL_BLOCKED_APP, processName),

  /**
   * Force-terminate multiple blocked processes at once.
   * @param {string[]} processNames
   */
  killAllProcesses: (processNames) =>
    safeInvoke(IPC.KILL_ALL_BLOCKED_APPS, processNames),

  /** Phase 5: can the current user actually satisfy an elevation prompt?
   *  False for standard users, so the UI can withhold an offer that would
   *  only produce a credential dialog they cannot complete. */
  canElevate: () => safeInvoke(IPC.CAN_ELEVATE),

  /** Phase 5: explicit, user-initiated elevated retry. Shows a system consent
   *  prompt, so main refuses it outright during an active interview. */
  killProcessElevated: (processName) =>
    safeInvoke(IPC.KILL_BLOCKED_APP_ELEVATED, processName),

  // ── Auto-updater (ADD-01) ──────────────────────────────────────────────────
  /**
   * Subscribe to update-available events from the main process.
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateAvailable: (callback) => {
    if (_updateAvailableHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
    }
    _updateAvailableHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
  },
  removeUpdateAvailableListener: () => {
    if (_updateAvailableHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_AVAILABLE, _updateAvailableHandler);
      _updateAvailableHandler = null;
    }
  },

  /**
   * Subscribe to update-downloaded events (update ready to install).
   * @param {(data: { version: string }) => void} callback
   */
  onUpdateDownloaded: (callback) => {
    if (_updateDownloadedHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
    }
    _updateDownloadedHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
  },
  removeUpdateDownloadedListener: () => {
    if (_updateDownloadedHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_DOWNLOADED, _updateDownloadedHandler);
      _updateDownloadedHandler = null;
    }
  },

  /** Quit the app and silently install the downloaded update (ignored during an interview). */
  installUpdate: () => safeSend(IPC.INSTALL_UPDATE),

  /** Pull the current updater snapshot to recover any events missed before listeners attached. */
  getUpdateState: () => safeInvoke(IPC.GET_UPDATE_STATE),

  /**
   * Subscribe to download-progress events.
   * @param {(data: { percent: number, bytesPerSecond?: number }) => void} callback
   */
  onUpdateProgress: (callback) => {
    if (_updateProgressHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_PROGRESS, _updateProgressHandler);
    }
    _updateProgressHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_PROGRESS, _updateProgressHandler);
  },

  /**
   * Subscribe to updater error events.
   * @param {(data: { error: string }) => void} callback
   */
  onUpdateError: (callback) => {
    if (_updateErrorHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_ERROR, _updateErrorHandler);
    }
    _updateErrorHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_ERROR, _updateErrorHandler);
  },

  /**
   * Subscribe to coarse updater state changes (idle/checking/available/
   * downloading/downloaded/error).
   * @param {(data: { state: string, version?: string|null }) => void} callback
   */
  onUpdateState: (callback) => {
    if (_updateStateHandler) {
      ipcRenderer.removeListener(IPC.PUSH_UPDATE_STATE, _updateStateHandler);
    }
    _updateStateHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_UPDATE_STATE, _updateStateHandler);
  },

  /** Returns the running application version string. */
  getAppVersion: () => safeInvoke(IPC.GET_APP_VERSION),

  // ── Audit trail (ADD-07) ───────────────────────────────────────────────────
  /** Fetch the full in-memory session audit log. */
  getAuditLog: () => safeInvoke(IPC.GET_AUDIT_LOG),

  // ── Streaming Preflight (ADD-02) ───────────────────────────────────────────
  /**
   * Subscribe to per-step preflight progress events.
   * Replaces the previous single-response approach — cards update as each
   * check completes instead of all at once at the end.
   * Automatically removes any previously registered listener before adding.
   * @param {(data: { step: string, status: 'running'|'done', result: any }) => void} callback
   */
  onPreflightProgress: (callback) => {
    if (_preflightProgressHandler) {
      ipcRenderer.removeListener(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
    }
    _preflightProgressHandler = (_event, data) => callback(data);
    safeOn(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
  },

  /**
   * Remove the active preflight progress listener.
   * Always call this in the finally block of runScans().
   */
  removePreflightProgressListener: () => {
    if (_preflightProgressHandler) {
      ipcRenderer.removeListener(IPC.PREFLIGHT_PROGRESS, _preflightProgressHandler);
      _preflightProgressHandler = null;
    }
  },

  // ── Warning push (ADD-06) ─────────────────────────────────────────────────
  /**
   * Subscribe to soft-violation warning pushes from the main process.
   * @param {(data: { message: string, severity: string }) => void} callback
   */
  onWarning: (callback) => {
    if (_warningHandler) {
      ipcRenderer.removeListener(IPC.PUSH_WARNING, _warningHandler);
    }
    _warningHandler = (_event, data) => callback(data);
    safeOn(IPC.PUSH_WARNING, _warningHandler);
  },
  removeWarningListener: () => {
    if (_warningHandler) {
      ipcRenderer.removeListener(IPC.PUSH_WARNING, _warningHandler);
      _warningHandler = null;
    }
  },

  // ── Violation bridge (interview active phase) ───────────────────────────────
  /**
   * Register a callback to receive ALL violation events pushed from the
   * Electron main process during an active interview session.
   *
   * The payload shape:
   *   { event, severity, count, isHardBlock, source, timestamp }
   *
   * isHardBlock: true  → terminate session (website decides UI)
   * isHardBlock: false → show warning toast (interview continues)
   *
   * Safe to call multiple times (e.g. React re-render) — previous listener
   * is removed before the new one is registered to prevent duplicates.
   *
   * @param {(payload: object) => void} callback
   */
  onViolation: (callback) => {
    if (_violationHandler) {
      ipcRenderer.removeListener(IPC.PUSH_VIOLATION, _violationHandler);
    }
    _violationHandler = (_, payload) => callback(payload);
    safeOn(IPC.PUSH_VIOLATION, _violationHandler);
  },

  /**
   * Unregister the violation listener.
   * Call this on component unmount or session end to avoid memory leaks.
   */
  removeViolationListener: () => {
    if (_violationHandler) {
      ipcRenderer.removeListener(IPC.PUSH_VIOLATION, _violationHandler);
      _violationHandler = null;
    }
  },

  /**
   * Acknowledge a received violation. Call this from your onViolation handler
   * (hard AND soft) to tell Electron the renderer is alive and handling it.
   * While acks keep arriving, Electron will NOT self-enforce — your in-app
   * warning/termination flow stays in control. If acks stop (page crashed /
   * listener dropped), Electron falls back to its own violation screen.
   *
   * Safe to call in a plain browser — no-ops if electronAPI is unavailable.
   */
  acknowledgeViolation: () => safeSend(IPC.ACK_VIOLATION),

  // ── Interview session end ─────────────────────────────────────────────────
  /**
   * Signal to Electron that the interview session has ended.
   * Electron will exit kiosk mode and restore close / minimize access.
   *
   * Safe to call in a regular browser — no-ops if electronAPI is unavailable.
   *
   * @param {"completed"|"auto-submitted"|"terminated"|"expired"} reason
   */
  interviewComplete: (reason) =>
    safeSend(IPC.INTERVIEW_COMPLETE, { reason }),

  getAppList: () => safeInvoke(IPC.GET_APP_LIST),

  // ── Screen recording / proctoring ─────────────────────────────────────────
  /**
   * Tell Electron to start screen + mic recording and upload chunks to the backend.
   * Call this when the interview session begins.
   * @param {{ sessionId?: string, interviewId?: string }} meta
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  startProctoring: (meta) => safeInvoke(IPC.PROCTORING_START, meta || {}),

  /**
   * Tell Electron to stop recording. The final chunk is flushed before the
   * recorder window closes.
   */
  stopProctoring: () => safeSend(IPC.PROCTORING_STOP),

  /**
   * Called when Electron confirms the MediaRecorder has actually started.
   * Fires after startProctoring resolves — use this to show a "recording" indicator.
   * @param {() => void} callback
   */
  onProctoringStarted: (callback) => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PROCTORING_STARTED);
    safeOn(IPC.PUSH_PROCTORING_STARTED, () => callback());
  },

  /**
   * Called if screen capture or MediaRecorder fails.
   * @param {(data: { error: string }) => void} callback
   */
  onProctoringError: (callback) => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PROCTORING_ERROR);
    safeOn(IPC.PUSH_PROCTORING_ERROR, (_, data) => callback(data));
  },

  // ── Pre-proceed watcher (background blocked-app status) ───────────────────
  /**
   * Subscribe to real-time blocked-app status pushes from the background
   * pre-proceed watcher (active after preflight passes, stopped on Proceed).
   *
   * Payload: { clean: boolean, apps: string[] }
   *   clean: true  → all clear, Proceed button should be enabled
   *   clean: false → blocked apps still running, Proceed should be disabled
   *
   * @param {(payload: { clean: boolean, apps: string[] }) => void} callback
   */
  onPreProceedStatus: (callback) => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PRE_PROCEED_STATUS);
    safeOn(IPC.PUSH_PRE_PROCEED_STATUS, (_e, data) => callback(data));
  },

  /** Unsubscribe when leaving the preflight screen. */
  removePreProceedStatusListener: () => {
    ipcRenderer.removeAllListeners(IPC.PUSH_PRE_PROCEED_STATUS);
  },

  // ── Localization ───────────────────────────────────────────────────────────
  /** Returns the candidate's active locale code (persisted pref or OS default). */
  getLocale: () => safeInvoke(IPC.GET_LOCALE),

  /** Sets and persists the candidate's chosen locale; broadcasts the change. */
  setLocale: (locale) => safeInvoke(IPC.SET_LOCALE, locale),

  /** Fetches the translation bundle (flat key → string map) for a locale. */
  getTranslations: (locale) => safeInvoke(IPC.GET_TRANSLATIONS, locale),

  /** Returns the list of supported locales: [{ code, name, dir }]. */
  getSupportedLocales: () => safeInvoke(IPC.GET_SUPPORTED_LOCALES),

  /**
   * Subscribe to locale changes broadcast from other windows/instances.
   * @param {(locale: string) => void} callback
   */
  onLocaleChanged: (callback) => {
    ipcRenderer.removeAllListeners(IPC.LOCALE_CHANGED);
    safeOn(IPC.LOCALE_CHANGED, (_e, locale) => callback(locale));
  },
  removeLocaleChangedListener: () => {
    ipcRenderer.removeAllListeners(IPC.LOCALE_CHANGED);
  },
});

// ─── Input Security (capture phase) ─────────────────────────────────────────
// Use capture:true to intercept events BEFORE the webpage can stop them.

document.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (["c", "v", "u"].includes(key)) {
        // Allow Ctrl+V paste into form inputs on auth pages (login / dashboard).
        // Copy and View-Source remain blocked unconditionally.
        const tag = e.target?.tagName;
        if (key === "v" && (tag === "INPUT" || tag === "TEXTAREA")) {
          return; // let the browser handle native paste
        }
        e.preventDefault();
        e.stopPropagation();
      }
    }

    // Block PrintScreen
    if (e.key === "PrintScreen") {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);
