"use strict";

// process.defaultApp is true only under `electron .`, and undefined both in
// packaged builds and under plain node.
const IS_DEV = process.defaultApp === true;

/**
 * .env location: repo root in dev, next to the installed executable in a
 * packaged build (the app dir is inside a read-only asar, so an editable file
 * has to live beside process.execPath).
 */
function _dotEnvPath() {
  const path = require("path");
  return IS_DEV
    ? path.join(__dirname, "../../.env")
    : path.join(path.dirname(process.execPath), ".env");
}

/** Loads .env into process.env, letting real environment values win. */
function _loadDotEnv() {
  let text;
  try {
    text = require("fs").readFileSync(_dotEnvPath(), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

_loadDotEnv();

/** Port the Python security agent listens on. */
const AGENT_PORT = 9999;

/** Loopback host for the Python security agent. */
const AGENT_HOST = "127.0.0.1";

/** Interval between each poll attempt while waiting for agent. */
const AGENT_POLL_INTERVAL_MS = 500;

/**
 * Budget for a cold agent spawn to report ready (measured ~1.6s). Doubles as the
 * startup grace window in which a booting agent is never killed and respawned.
 */
const AGENT_READY_TIMEOUT_MS = 10000;

/** Max wait for a fast agent command (ping / cached status). */
const AGENT_REQUEST_TIMEOUT_MS = 2000;

/** Max wait for a full deep scan — the agent runs all 8 checks under this. */
const AGENT_SCAN_TIMEOUT_MS = 12000;

/**
 * Lowest agent.py `contract_version` trusted here; older builds predate fields
 * the verdict depends on. Bump with agent.py's CONTRACT_VERSION when a new field
 * becomes load-bearing.
 */
const MINIMUM_SUPPORTED_CONTRACT_VERSION = 2;

// Base URL of the interview web app.
const INTERVIEW_BASE_URL = process.env.INTERVIEW_FRONTEND_BASE_URL;

// Base URL of the LetsHyre REST API.
const API_BASE_URL = process.env.API_BASE_URL;

// DEVTOOLS=true (or 1) docks DevTools on the right at launch and lets
// F12 / Ctrl+Shift+I through the input lockdown.
const DEVTOOLS_ENABLED = /^(1|true)$/i.test(process.env.DEVTOOLS);

// Optional help link on the security check; only an https URL is ever opened.
const SUPPORT_URL = process.env.SUPPORT_URL || "";

// Optional support address the interview site can show next to the link.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "";

// Optional preflight endpoints, relative to API_BASE_URL; off unless a "/" path.
const _apiPath = (value) => (/^\/\S*$/.test(value || "") ? value : "");
const PREFLIGHT_POLICY_PATH = _apiPath(process.env.PREFLIGHT_POLICY_PATH);
const PREFLIGHT_TELEMETRY_PATH = _apiPath(process.env.PREFLIGHT_TELEMETRY_PATH);

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

/** How long the site has to acknowledge a hard block before it is sent again. */
const HARD_BLOCK_GRACE_MS = 8000;

// Preflight checks run concurrently, each under its own deadline; a missed
// deadline marks only that check unverified.
// INVARIANT: PREFLIGHT_RENDERER_TIMEOUT_MS > PREFLIGHT_GLOBAL_DEADLINE_MS.

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

/** Deadline for the agent probe: a cold spawn, then the deep scan. */
const PREFLIGHT_AGENT_DEADLINE_MS = AGENT_READY_TIMEOUT_MS + AGENT_SCAN_TIMEOUT_MS;

/** Ceiling for one whole preflight pass in the main process. The agent is the
 *  slowest probe by a wide margin; the margin covers verdict assembly. */
const PREFLIGHT_GLOBAL_DEADLINE_MS = PREFLIGHT_AGENT_DEADLINE_MS + 2000;

/** Renderer-side abort. Must exceed the global deadline so the main process is
 *  always the component that decides a scan is over. */
const PREFLIGHT_RENDERER_TIMEOUT_MS = PREFLIGHT_GLOBAL_DEADLINE_MS + 5000;

/** Results older than this are considered stale and will not enable Proceed. */
const PREFLIGHT_RESULT_MAX_AGE_MS = 60000;

/** Budget for the quick re-check that renews a stale pass on Continue. */
const PREFLIGHT_REVERIFY_DEADLINE_MS = 3000;

/** How often the security-check page re-polls processes and displays. */
const PRE_PROCEED_INTERVAL_MS = 2000;

/** How often the guard re-checks the machine on permissions, verification and role selection. */
const GUARD_INTERVAL_MS = 2000;

/** Clean guard ticks in a row before a violation counts as resolved. */
const GUARD_CLEAR_TICKS = 2;

/** Guard ticks in a row that couldn't answer before the page is blocked as unverified. */
const GUARD_UNVERIFIED_TICKS = 3;

/** Budget for the fresh check run before each step and on "Check again". */
const GUARD_DOOR_CHECK_DEADLINE_MS = 2500;

/** Most unacknowledged violations kept for re-sending to the interview site. */
const MAX_UNACKED_VIOLATIONS = 20;

/** Consecutive failed agent scans before the next scan restarts the agent. */
const AGENT_RESTART_AFTER_FAILURES = 2;

/** Auto-respawn backoff: doubles from the base up to the cap. */
const AGENT_RESPAWN_BASE_MS = 2000;
const AGENT_RESPAWN_MAX_MS = 30000;

/** An agent that stayed up this long resets the respawn backoff. */
const AGENT_STABLE_UPTIME_MS = 60000;

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
 * Budget for an elevated kill. Generous because it spans a UAC /
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
  // Dashboard → the security check alone, as a practice run
  START_PRACTICE_CHECK: "start-practice-check",

  // Candidate profile (authenticated GET, returns attempts + display fields)
  GET_CANDIDATE_PROFILE: "get-candidate-profile",

  // Proxy an image URL through main process (bypasses renderer CSP) → data URL
  FETCH_PROFILE_IMAGE: "fetch-profile-image",

  // Permissions page: preflight Proceed → main loads permissions.html
  LOAD_PERMISSIONS_PAGE: "load-permissions-page",
  BACK_TO_PERMISSIONS: "back-to-permissions",

  // Identity verification page
  LOAD_IDENTITY_VERIFICATION: "load-identity-verification",
  SUBMIT_VOICE_SAMPLE: "submit-voice-sample",
  SUBMIT_FACE_VERIFICATION: "submit-face-verification",

  // Role selection page
  LOAD_ROLE_SELECTION: "load-role-selection",
  SUBMIT_ROLE: "submit-role",

  // Interview rules page
  LOAD_INTERVIEW_RULES: "load-interview-rules",
  GET_INTERVIEW_RULES: "get-interview-rules",

  // Back navigation
  LOAD_DASHBOARD: "load-dashboard",
  LOAD_SECURITY_CHECK: "load-security-check",
  LOAD_LANGUAGE_SELECTION: "load-language-selection",

  // Preflight
  RUN_PREFLIGHT: "run-preflight-scans",

  // Interview flow
  PROCEED_TO_INTERVIEW: "proceed-to-interview",

  // Process management
  KILL_BLOCKED_APP: "kill-blocked-app",
  KILL_ALL_BLOCKED_APPS: "kill-all-blocked-apps",
  /** explicit, user-initiated elevated retry (shows a consent prompt). */
  KILL_BLOCKED_APP_ELEVATED: "kill-blocked-app-elevated",
  /** Whether the current user could actually satisfy an elevation prompt. */
  CAN_ELEVATE: "can-elevate",
  /** Kill one process the agent reported as a threat, by PID. */
  KILL_THREAT_PROCESS: "kill-threat-process",

  // Support link on the security check
  GET_SUPPORT_INFO: "get-support-info",
  OPEN_SUPPORT: "open-support",
  /** Support link and address for the interview site. */
  GET_SUPPORT_CONTACT: "get-support-contact",

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

  // Audit trail
  GET_AUDIT_LOG: "get-audit-log",

  // App list
  GET_APP_LIST: "get-app-list",

  // Soft-violation warning push (main → renderer)
  PUSH_WARNING: "push-warning",

  // Streaming preflight — main pushes per-step results as they complete
  PREFLIGHT_PROGRESS: "preflight-progress",

  // Preflight UX: allow user to minimize to manage other apps manually
  MINIMIZE_WINDOW: "minimize-window",

  // Violation bridge: main → renderer push (forwarded to interview.letshyre.com website)
  PUSH_VIOLATION: "push-violation",

  // Interview session end: website → main (lifts window lockdown)
  INTERVIEW_COMPLETE: "interview-complete",

  // Scorecard "View Dashboard" button: website → main (leaves the interview
  // flow after interview-complete already lifted lockdown)
  VIEW_DASHBOARD: "view-dashboard",

  // The site could not start the interview: website → main, back to the dashboard.
  ABORT_INTERVIEW: "abort-interview",

  // Violation ack: website → main; an unacknowledged hard block is sent again.
  ACK_VIOLATION: "ack-violation",

  // Pre-proceed watcher: main → renderer, live status on the security-check page.
  // Payload: { clean, unverified, apps, verdicts }
  PUSH_PRE_PROCEED_STATUS: "push-pre-proceed-status",

  // Security guard on the steps between the security check and the interview.
  GET_GUARD_STATUS: "get-guard-status",
  RECHECK_GUARD: "recheck-guard",
  PUSH_GUARD_STATUS: "push-guard-status",

  // Store the captured ID-verification photo, injected into interview SPA
  // sessionStorage before React boots.
  STORE_CANDIDATE_PHOTO: "store-candidate-photo",

  // Screen recording / proctoring — triggered by interview.letshyre.com
  PROCTORING_START: "proctoring-start", // renderer invoke → main
  PROCTORING_STOP: "proctoring-stop", // renderer send → main

  // Push to interview site (main → renderer)
  PUSH_PROCTORING_STARTED: "push-proctoring-started",
  PUSH_PROCTORING_ERROR: "push-proctoring-error",

  // Dev only (DEVTOOLS): fire a violation code through the real pipeline.
  DEV_SIMULATE_VIOLATION: "dev-simulate-violation",

  // Internal: hidden recorder window ↔ main (NOT exposed to interview site)
  RECORDER_INIT: "recorder:init",
  RECORDER_STOP: "recorder:stop",
  RECORDER_READY: "recorder:ready",
  RECORDER_CHUNK: "recorder:chunk",
  RECORDER_ERROR: "recorder:error",
  RECORDER_STOPPED: "recorder:stopped", // renderer → main after final chunk flush
  RECORDER_SET_BITRATE: "recorder:set-bitrate",

  // How-it-works page navigation
  LOAD_HOW_IT_WORKS: "load-how-it-works",
  RETRY_INTERVIEW: "retry-interview",

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
  { code: "en", name: "English", english: "English", dir: "ltr", reviewed: true },
  { code: "hi", name: "हिन्दी", english: "Hindi", dir: "ltr", reviewed: false },
  { code: "te", name: "తెలుగు", english: "Telugu", dir: "ltr", reviewed: false },
  { code: "ta", name: "தமிழ்", english: "Tamil", dir: "ltr", reviewed: false },
  { code: "kn", name: "ಕನ್ನಡ", english: "Kannada", dir: "ltr", reviewed: false },
  { code: "ml", name: "മലയാളം", english: "Malayalam", dir: "ltr", reviewed: false },
  { code: "ja", name: "日本語", english: "Japanese", dir: "ltr", reviewed: false },
  { code: "ru", name: "Русский", english: "Russian", dir: "ltr", reviewed: false },
  { code: "ar", name: "العربية", english: "Arabic", dir: "rtl", reviewed: false },
  { code: "fr", name: "Français", english: "French", dir: "ltr", reviewed: false },
  { code: "ur", name: "اردو", english: "Urdu", dir: "rtl", reviewed: false },
  { code: "bn", name: "বাংলা", english: "Bengali", dir: "ltr", reviewed: false },
  { code: "es", name: "Español", english: "Spanish", dir: "ltr", reviewed: false },
  { code: "de", name: "Deutsch", english: "German", dir: "ltr", reviewed: false },
  { code: "pt", name: "Português", english: "Portuguese", dir: "ltr", reviewed: false },
  { code: "it", name: "Italiano", english: "Italian", dir: "ltr", reviewed: false },
  { code: "nl", name: "Nederlands", english: "Dutch", dir: "ltr", reviewed: false },
  { code: "ko", name: "한국어", english: "Korean", dir: "ltr", reviewed: false },
  { code: "id", name: "Bahasa Indonesia", english: "Indonesian", dir: "ltr", reviewed: false },
];

/** The custom deep-link scheme registered with the OS. */
const PROTOCOL_SCHEME = "letshyre";

module.exports = {
  IS_DEV,
  AGENT_PORT,
  AGENT_HOST,
  AGENT_POLL_INTERVAL_MS,
  AGENT_READY_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_MS,
  AGENT_SCAN_TIMEOUT_MS,
  MINIMUM_SUPPORTED_CONTRACT_VERSION,
  INTERVIEW_BASE_URL,
  API_BASE_URL,
  DEVTOOLS_ENABLED,
  SUPPORT_URL,
  SUPPORT_EMAIL,
  PREFLIGHT_POLICY_PATH,
  PREFLIGHT_TELEMETRY_PATH,
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
  PREFLIGHT_REVERIFY_DEADLINE_MS,
  PRE_PROCEED_INTERVAL_MS,
  GUARD_INTERVAL_MS,
  GUARD_CLEAR_TICKS,
  GUARD_UNVERIFIED_TICKS,
  GUARD_DOOR_CHECK_DEADLINE_MS,
  MAX_UNACKED_VIOLATIONS,
  AGENT_RESTART_AFTER_FAILURES,
  AGENT_RESPAWN_BASE_MS,
  AGENT_RESPAWN_MAX_MS,
  AGENT_STABLE_UPTIME_MS,
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
