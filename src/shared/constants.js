/**
 * Single source of truth for magic values used across the app.
 * Import from here — never hard-code ports, URLs, or IPC channel strings.
 */

"use strict";

// ─── Backend / Agent

/** Port the Python security agent listens on. */
const AGENT_PORT = 9999;

/** Loopback host for the Python security agent. */
const AGENT_HOST = "127.0.0.1";

/** Interval between each poll attempt while waiting for agent. */
const AGENT_POLL_INTERVAL_MS = 500;

/**
 * Budget for whenAgentReady(): covers a cold spawn (stale-kill + PyInstaller
 * unpack + interpreter boot) before the agent is declared not-ready. Doubles as
 * the startup grace window during which a booting agent is never killed and
 * respawned.
 *
 * The agent now announces itself with a `ready` event the moment its stdin loop
 * is live, so this only has to cover process start — not a first scan. Measured
 * spawn→ready is ~1.6s; 10s leaves ~6x headroom for a slow disk.
 */
const AGENT_READY_TIMEOUT_MS = 10000;

/** Max wait for a fast agent command (ping / cached status). */
const AGENT_REQUEST_TIMEOUT_MS = 2000;

/** Max wait for a full deep scan — the agent runs all 8 checks under this. */
const AGENT_SCAN_TIMEOUT_MS = 12000;

/**
 * Lowest agent.py `contract_version` the Electron side trusts. Below this (or
 * missing entirely, true of every pre-v2 build) the response shape predates
 * fields this verdict depends on — e.g. v1's `safe_to_proceed` never accounted
 * for a check erroring, so a silent v1 "clean" can't be told apart from one
 * that just didn't know to say otherwise. Bump this in lockstep with
 * agent.py's CONTRACT_VERSION whenever a new field becomes load-bearing here.
 */
const MINIMUM_SUPPORTED_CONTRACT_VERSION = 2;

// ─── URLs

// Base URL of the interview web app.
const INTERVIEW_BASE_URL =
  process.env.INTERVIEW_FRONTEND_BASE_URL || "https://interview.letshyre.com";

// Base URL of the LetsHyre REST API. Overridable via env for staging / tests.
const API_BASE_URL = process.env.API_BASE_URL || "https://api.letshyre.com";

/** Auth API paths (relative to API_BASE_URL). */
const AUTH_LOGIN_PATH = "/user/v1/login/";
const AUTH_LOGOUT_PATH = "/user/v1/logout/";
const CANDIDATE_PROFILE_PATH = "/user/v1/candidate_profile/";
const TOKEN_REFRESH_PATH = "/user/v1/login_refresh/";

/** Screen-recording upload API paths (relative to API_BASE_URL). */
const VIDEO_UPLOAD_START_PATH = "/user/v1/candidate_interview/video_upload/start/";
const VIDEO_UPLOAD_CHUNK_PATH = "/user/v1/candidate_interview/video_upload/chunk/";
const VIDEO_UPLOAD_COMPLETE_PATH = "/user/v1/candidate_interview/video_upload/complete/";
const VIDEO_UPLOAD_STATUS_PATH = "/user/v1/candidate_interview/video_upload/status/";

// ─── Detection / Violation
/** Minimum ms between repeated reports of the same violation event. */
const VIOLATION_COOLDOWN_MS = 15000;

/** How often (ms) to run hardware + agent deep-scan polls during interview. */
const DETECTION_INTERVAL_MS = 5000;

/** How often (ms) the Electron app sends a heartbeat to the backend during interview. */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * How often (ms) to re-check GitHub for app updates. Suppressed during an
 * active interview — a proctor client must never restart mid-session.
 */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** How long (ms) to wait before retrying a failed check/download, so a transient
 *  network blip doesn't strand a candidate until the next UPDATE_CHECK_INTERVAL_MS. */
const UPDATE_RETRY_MS = 5 * 60 * 1000; // 5 minutes

/** Max consecutive short retries before falling back to the normal periodic interval. */
const UPDATE_MAX_RETRIES = 3;

/**
 * Fail-closed: consecutive "indeterminate" checks (errored/timed out) tolerated
 * during an active interview before escalating to a violation. At
 * DETECTION_INTERVAL_MS = 5s, 3 ≈ 15s blind spot.
 */
const INDETERMINATE_ESCALATION_THRESHOLD = 3;

/**
 * Grace period (ms) after a hard-block violation before Electron self-enforces.
 * The violation goes to the website first; if the session is still active after
 * this window (site dropped the event or failed to terminate), Electron lifts
 * lockdown and shows the local violation screen itself.
 */
const HARD_BLOCK_GRACE_MS = 8000;

// Checks run concurrently, each under its own deadline. A check that misses
// its deadline is reported "unverified" (fail-closed, blocks Proceed) rather
// than failing the whole scan.
//
// INVARIANT: PREFLIGHT_RENDERER_TIMEOUT_MS > PREFLIGHT_GLOBAL_DEADLINE_MS.
// These used to live apart (renderer 20s vs. main-side worst case ~31s), so a
// cold start could get the renderer aborting a scan still in progress and
// retry-storming. Both sides now derive from here so they can't drift apart.

/** Deadline for the native display probe (Electron screen API — effectively instant). */
const PREFLIGHT_HDMI_DEADLINE_MS = 1000;

/** Deadline for the blocked-process scan (tasklist / ps). */
const PREFLIGHT_PROCESS_DEADLINE_MS = 4000;

/**
 * Time reserved at the end of the agent budget for the deep scan itself, once
 * the agent answers; the rest is spent waiting for it to exist. Equal to the
 * scan's own timeout by definition — reserving less would let withDeadline()
 * cut off a scan the agent client is still legitimately waiting on.
 */
const PREFLIGHT_AGENT_SCAN_RESERVE_MS = AGENT_SCAN_TIMEOUT_MS;

/**
 * Deadline for the agent probe: wait for a cold spawn, then run the deep scan.
 * Derived rather than tuned, so the two halves can't be changed independently
 * and leave the liveness wait quietly starved (the original failure mode).
 */
const PREFLIGHT_AGENT_DEADLINE_MS = AGENT_READY_TIMEOUT_MS + AGENT_SCAN_TIMEOUT_MS;

/** Ceiling for one whole preflight pass in the main process. The agent is the
 *  slowest probe by a wide margin; the margin covers verdict assembly. */
const PREFLIGHT_GLOBAL_DEADLINE_MS = PREFLIGHT_AGENT_DEADLINE_MS + 2000;

/** Renderer-side abort. Must exceed the global deadline so the main process is
 *  always the component that decides a scan is over. */
const PREFLIGHT_RENDERER_TIMEOUT_MS = PREFLIGHT_GLOBAL_DEADLINE_MS + 5000;

/** Results older than this are considered stale and will not enable Proceed. */
const PREFLIGHT_RESULT_MAX_AGE_MS = 60000;

// ─── Process termination budget
// killSingleProcess() spends enum + kill + verify + relaunch-watch, ≈12s worst
// case, ~1-2s in the common path. killAllProcesses() runs apps concurrently, so
// N apps cost the same as one.

/** Max ms for a single process-enumeration / taskkill helper invocation. */
const KILL_ENUM_TIMEOUT_MS = 5000;

/** How long to keep re-checking that a killed app's PIDs are actually gone. */
const KILL_VERIFY_TIMEOUT_MS = 3000;

/** Interval between those verification polls. */
const KILL_VERIFY_POLL_MS = 400;

/**
 * After the app goes clear, how long to keep watching for it to come back.
 * A surviving launcher/updater typically respawns within ~1-2s; a reappearance
 * in this window is reported as outcome "respawned".
 */
const KILL_RELAUNCH_WATCH_MS = 3000;

/** Interval between relaunch-watch polls. */
const KILL_RELAUNCH_POLL_MS = 600;

/**
 * Budget for an elevated kill (Phase 5). Generous because it spans a UAC /
 * osascript prompt a human has to read and accept, but still bounded so a
 * prompt left untouched can't wedge the preflight forever.
 */
const KILL_ELEVATE_TIMEOUT_MS = 60000;

// Keep these in sync with preload.js exposures and ipcHandlers.js registrations.
// Convention:
//   - Plain names  → renderer invokes main (ipcRenderer.send / invoke)
//   - PUSH_ prefix → main pushes to renderer (webContents.send)

const IPC = {
  // App control
  QUIT_APP: "quit-app",
  RECHECK_SYSTEM: "recheck-system",

  // Auth (renderer invoke → main; tokens stay in main)
  AUTH_LOGIN: "auth-login",
  AUTH_LOGOUT: "auth-logout",
  GET_AUTH_USER: "get-auth-user",

  // Dashboard → start the security check for the logged-in session
  START_INTERVIEW: "start-interview",

  // Candidate profile (authenticated GET, returns attempts + display fields)
  GET_CANDIDATE_PROFILE: "get-candidate-profile",

  // Proxy an image URL through main process (bypasses renderer CSP) → data URL
  FETCH_PROFILE_IMAGE: "fetch-profile-image",

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

  // Preflight
  RUN_PREFLIGHT: "run-preflight-scans",

  // Interview flow
  PROCEED_TO_INTERVIEW: "proceed-to-interview",

  // Process management
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",
  /** Phase 5: explicit, user-initiated elevated retry (shows a consent prompt). */
  KILL_BLOCKED_APP_ELEVATED: "kill-blocked-app-elevated",
  /** Whether the current user could actually satisfy an elevation prompt. */
  CAN_ELEVATE: "can-elevate",

  // Auto-updater (main → renderer push)
  PUSH_UPDATE_AVAILABLE: "push-update-available",
  PUSH_UPDATE_DOWNLOADED: "push-update-downloaded",
  PUSH_UPDATE_PROGRESS: "push-update-progress",
  PUSH_UPDATE_ERROR: "push-update-error",
  PUSH_UPDATE_STATE: "push-update-state",

  // Auto-updater (renderer → main)
  INSTALL_UPDATE: "install-update",

  // Auto-updater state pull (renderer invoke → main) — recover missed events
  GET_UPDATE_STATE: "get-update-state",

  // App version (renderer invoke → main)
  GET_APP_VERSION: "get-app-version",

  // Audit trail (ADD-07)
  GET_AUDIT_LOG: "get-audit-log",

  // App list (ADD-10)
  GET_APP_LIST: "get-app-list",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // ADD-02: Streaming preflight — main pushes per-step results as they complete
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push (forwarded to interview.letshyre.com website)
  PUSH_VIOLATION: "push-violation",

  // Interview session end: website → main (lifts window lockdown)
  INTERVIEW_COMPLETE: "interview-complete",

  // Violation ack: website → main via renderer's onViolation handler. While
  // acks keep arriving, Electron's self-enforcement failsafe stays suppressed;
  // if they stop (renderer crashed/listener dropped), the failsafe kicks in.
  ACK_VIOLATION: "ack-violation",

  // Pre-proceed watcher: main → renderer, real-time blocked-app status on the
  // "All checks passed" screen. Payload: { clean: boolean, apps: string[] }
  PUSH_PRE_PROCEED_STATUS: "push-pre-proceed-status",

  // Store the captured ID-verification photo, injected into interview SPA
  // sessionStorage before React boots.
  STORE_CANDIDATE_PHOTO: "store-candidate-photo",

  // Screen recording / proctoring — triggered by interview.letshyre.com
  PROCTORING_START: "proctoring-start", // renderer invoke → main
  PROCTORING_STOP: "proctoring-stop", // renderer send → main

  // Push to interview site (main → renderer)
  PUSH_PROCTORING_STARTED: "push-proctoring-started",
  PUSH_PROCTORING_ERROR: "push-proctoring-error",

  // Internal: hidden recorder window ↔ main (NOT exposed to interview site)
  RECORDER_INIT: "recorder:init",
  RECORDER_STOP: "recorder:stop",
  RECORDER_READY: "recorder:ready",
  RECORDER_CHUNK: "recorder:chunk",
  RECORDER_ERROR: "recorder:error",
  RECORDER_STOPPED: "recorder:stopped", // renderer → main after final chunk flush

  // How-it-works page navigation
  LOAD_HOW_IT_WORKS: "load-how-it-works",

  // Localization (renderer invoke → main)
  GET_LOCALE: "get-locale",
  SET_LOCALE: "set-locale",
  GET_TRANSLATIONS: "get-translations",
  GET_SUPPORTED_LOCALES: "get-supported-locales",
  GET_I18N_BOOTSTRAP: "get-i18n-bootstrap",

  // Localization (main → renderer push, broadcast to all windows on change)
  LOCALE_CHANGED: "locale-changed",
};

/** Locale used when no preference is stored and the OS locale isn't supported. */
const DEFAULT_LOCALE = "en";

/**
 * Supported UI languages. `dir` drives document direction (RTL for Arabic).
 * `reviewed` marks human-certified-translator sign-off — only `en` is
 * reviewed today; the rest gate to dev/QA builds until certified (see
 * localeManager.js's `_localeAllowed()`). Keep in sync with the JSON files
 * under assets/locales/.
 */
const SUPPORTED_LOCALES = [
  { code: "en", name: "English", dir: "ltr", reviewed: true },
  { code: "hi", name: "हिन्दी", dir: "ltr", reviewed: false },
  { code: "te", name: "తెలుగు", dir: "ltr", reviewed: false },
  { code: "ta", name: "தமிழ்", dir: "ltr", reviewed: false },
  { code: "kn", name: "ಕನ್ನಡ", dir: "ltr", reviewed: false },
  { code: "ml", name: "മലയാളം", dir: "ltr", reviewed: false },
  { code: "ja", name: "日本語", dir: "ltr", reviewed: false },
  { code: "ru", name: "Русский", dir: "ltr", reviewed: false },
  { code: "ar", name: "العربية", dir: "rtl", reviewed: false },
  { code: "fr", name: "Français", dir: "ltr", reviewed: false },
  { code: "ur", name: "اردو", dir: "rtl", reviewed: false },
  { code: "bn", name: "বাংলা", dir: "ltr", reviewed: false },
  { code: "es", name: "Español", dir: "ltr", reviewed: false },
  { code: "de", name: "Deutsch", dir: "ltr", reviewed: false },
  { code: "pt", name: "Português", dir: "ltr", reviewed: false },
  { code: "it", name: "Italiano", dir: "ltr", reviewed: false },
  { code: "nl", name: "Nederlands", dir: "ltr", reviewed: false },
  { code: "ko", name: "한국어", dir: "ltr", reviewed: false },
  { code: "id", name: "Bahasa Indonesia", dir: "ltr", reviewed: false },
];

/** The custom deep-link scheme registered with the OS. */
const PROTOCOL_SCHEME = "letshyre";

module.exports = {
  AGENT_PORT,
  AGENT_HOST,
  AGENT_POLL_INTERVAL_MS,
  AGENT_READY_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_MS,
  AGENT_SCAN_TIMEOUT_MS,
  MINIMUM_SUPPORTED_CONTRACT_VERSION,
  INTERVIEW_BASE_URL,
  API_BASE_URL,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  CANDIDATE_PROFILE_PATH,
  TOKEN_REFRESH_PATH,
  VIDEO_UPLOAD_START_PATH,
  VIDEO_UPLOAD_CHUNK_PATH,
  VIDEO_UPLOAD_COMPLETE_PATH,
  VIDEO_UPLOAD_STATUS_PATH,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RETRY_MS,
  UPDATE_MAX_RETRIES,
  INDETERMINATE_ESCALATION_THRESHOLD,
  HARD_BLOCK_GRACE_MS,
  PREFLIGHT_HDMI_DEADLINE_MS,
  PREFLIGHT_PROCESS_DEADLINE_MS,
  PREFLIGHT_AGENT_DEADLINE_MS,
  PREFLIGHT_AGENT_SCAN_RESERVE_MS,
  PREFLIGHT_GLOBAL_DEADLINE_MS,
  PREFLIGHT_RENDERER_TIMEOUT_MS,
  PREFLIGHT_RESULT_MAX_AGE_MS,
  KILL_ENUM_TIMEOUT_MS,
  KILL_ELEVATE_TIMEOUT_MS,
  KILL_VERIFY_TIMEOUT_MS,
  KILL_VERIFY_POLL_MS,
  KILL_RELAUNCH_WATCH_MS,
  KILL_RELAUNCH_POLL_MS,
  IPC,
  PROTOCOL_SCHEME,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
};
