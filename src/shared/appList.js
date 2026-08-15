/**
 * src/shared/appList.js
 * ─────────────────────
 * Single source of truth for all blocked / suspicious application names.
 *
 * Previously these lists were duplicated across:
 *   - main.js (KILLABLE_APPS)
 *   - src/detector/mirrorDetector.js (suspicious[])
 *   - assets/preflight.js (meetingApps, screenSharingApps, APP_DISPLAY_NAMES)
 *
 * Now there is ONE place. Update here — everywhere picks it up automatically.
 */

"use strict";

// ─── Per-category Lists ──────────────────────────────────────────────────────

const MEETING_APPS = [
  // Windows
  "zoom.exe",
  "teams.exe",
  "ms-teams.exe",
  "msteams.exe",
  "webex.exe",
  "gotomeeting.exe",
  "skype.exe",
  // macOS
  "zoom.app",
  "zoom.us.app",
  "teams.app",
  "microsoft teams.app",
  "webex.app",
  "webex meetings.app",
  "gotomeeting.app",
  "skype.app",
];

const SCREEN_SHARING_APPS = [
  // Windows
  "obs64.exe",
  "obs32.exe",
  "obs-studio.exe",
  "discord.exe",
  "slack.exe",
  "anydesk.exe",
  "teamviewer.exe",
  "bandicam.exe",
  "camtasia.exe",
  "snagit.exe",
  // macOS
  "obs.app",
  "obs studio.app",
  "discord.app",
  "slack.app",
  "anydesk.app",
  "teamviewer.app",
  "camtasia.app",
  "snagit.app",
];

const CASTING_APPS = [
  // Windows
  "scrcpy.exe",
  "miracast.exe",
  "apowermirror.exe",
  "letsview.exe",
  // macOS / cross-platform
  "scrcpy",
  "apowermirror.app",
  "letsview.app",
];

const BROWSER_APPS = [
  // Windows
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "opera.exe",
  "brave.exe",
  "vivaldi.exe",
  // macOS
  "google chrome.app",
  "microsoft edge.app",
  "firefox.app",
  "safari.app",
  "opera.app",
  "brave.app",
  "vivaldi.app",
];
const AI_CHEATING_APPS = [
  // Windows
  "pmodule.exe", // Parakeet AI (real process name)
  "parakeet.exe",
  "parakeetai.exe",
  "finalroundai.exe",
  "final round ai.exe",
  "finalround.exe",
  "interviewcoder.exe",
  "interview-coder.exe",
  "cluely.exe",
  "lockedinai.exe",
  "lockedin.exe",
  "locked-in.exe",
  "sensei.exe",
  "sensaiai.exe",
  "interviewsolver.exe",
  "interview-solver.exe",
  "interviewman.exe",
  "aceround.exe",
  "hedy.exe",
  "hedyai.exe",
  // macOS
  "pmodule.app",
  "parakeet.app",
  "parakeetai.app",
  "final round ai.app",
  "finalroundai.app",
  "interviewcoder.app",
  "cluely.app",
  "lockedinai.app",
  "lockedin ai.app",
  "sensai.app",
  "interviewsolver.app",
];

/** All blocked apps — used for process-kill whitelist validation. */
const ALL_BLOCKED_APPS = [
  ...MEETING_APPS,
  ...SCREEN_SHARING_APPS,
  ...CASTING_APPS,
  ...BROWSER_APPS,
  ...AI_CHEATING_APPS,
];

// ─── Companion / Relauncher Processes ────────────────────────────────────────

/**
 * Processes that can RELAUNCH a blocked app, or that keep it running in the
 * background after its window closes. Keyed by the blocked app's main image
 * name (lowercase, as it appears in ALL_BLOCKED_APPS). Values are lowercase
 * image names. These are KILL targets only — they are deliberately NOT added to
 * the detection blocklist, because a stray helper alone must not fail a scan.
 *
 * Safety rule for anyone extending this map: a companion must be EXCLUSIVE to
 * one vendor's product. Never add shared runtime/host processes (webview,
 * broker, shell, generic Squirrel/electron `update.exe`, crash handlers) —
 * killing those breaks unrelated software on the candidate's machine.
 */
const APP_COMPANIONS = {
  // ── Zoom ──
  // zoomlauncher: protocol/URL launcher that re-spawns zoom.exe.
  // cpthost + airhost: sharing/AirPlay hosts that survive the main window.
  "zoom.exe": ["zoomlauncher.exe", "cpthost.exe", "airhost.exe"],

  // ── Microsoft Teams ──
  // ms-teamsupdate: the new Teams updater, invoked by ms-teams.exe; it can
  // reinstall/relaunch the client. Classic Teams only ships the shared Squirrel
  // `update.exe`, which is intentionally omitted (not vendor-exclusive).
  // Classic Teams also ships the shared Squirrel `update.exe`; it is listed here
  // ONLY because APP_COMPANION_SCOPES pins it to Teams' own install directory.
  // Never add a shared image name here without a matching scope entry.
  "teams.exe": ["ms-teamsupdate.exe", "update.exe"],
  "ms-teams.exe": ["ms-teamsupdate.exe"],
  "msteams.exe": ["ms-teamsupdate.exe"],

  // ── Squirrel-based Electron apps ──
  // `update.exe` IS the relauncher for these, but the name is shared across
  // every Squirrel app, so both entries are path-scoped in APP_COMPANION_SCOPES.
  "discord.exe": ["update.exe"],
  "slack.exe": ["update.exe"],

  // ── Cisco Webex ──
  // ciscowebexstart: relauncher. webexhost/ciscocollabhost: persistent hosts
  // that pre-warm and re-open the meeting UI. atmgr/washost/wmlhost/ptoneclk:
  // tray + meeting helpers that keep running after the meeting window closes.
  "webex.exe": [
    "ciscowebexstart.exe",
    "webexhost.exe",
    "ciscocollabhost.exe",
    "atmgr.exe",
    "washost.exe",
    "wmlhost.exe",
    "ptoneclk.exe",
  ],

  // ── Skype ──
  // Background/host/bridge components of the packaged Skype app; the background
  // host re-activates the foreground app.
  "skype.exe": ["skypeapp.exe", "skypebackgroundhost.exe", "skypehost.exe", "skypebridge.exe"],

  // ── GoToMeeting ──
  // g2mlauncher: relauncher. g2mcomm: persistent comm service that reopens the
  // session UI. g2mui: meeting UI process.
  "gotomeeting.exe": ["g2mlauncher.exe", "g2mcomm.exe", "g2mui.exe"],

  // ── TeamViewer ──
  // teamviewer_service: Windows service that restarts teamviewer.exe on kill.
  // tv_w32 / tv_x64 / teamviewer_desktop: session hosts that keep accepting
  // incoming remote connections without the main window.
  "teamviewer.exe": ["teamviewer_service.exe", "tv_w32.exe", "tv_x64.exe", "teamviewer_desktop.exe"],

  // ── Snagit (TechSmith) ──
  // Editor + privileged helper that keep capture alive after the tray app exits.
  "snagit.exe": ["snagiteditor.exe", "snagpriv.exe"],
};

/**
 * Returns the known companion processes for a blocked app.
 * @param {string} processName
 * @returns {string[]} lowercase companion image names, [] if none known
 */
function getCompanions(processName) {
  if (typeof processName !== "string") {
    return [];
  }
  const key = processName.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(APP_COMPANIONS, key)) {
    return [];
  }
  return [...APP_COMPANIONS[key]];
}

// ─── Path-scoped companions ──────────────────────────────────────────────────

/**
 * Some relaunchers CANNOT be identified by image name alone because several
 * unrelated vendors ship the exact same one. The Squirrel installer framework is
 * the big case: Discord, Slack, classic Teams and most Electron apps all ship an
 * `Update.exe`, and that process is precisely what brings the app back after it
 * is killed. Terminating every `Update.exe` on the machine would take down
 * unrelated software the candidate depends on.
 *
 * These companions are therefore matched on image name AND install location: the
 * process's executable path must sit under the owning app's own directory.
 *
 * Keyed by blocked app → { companion image name → required path fragment }.
 * Fragments are lowercase and matched as a substring of the executable path, so
 * they are installation-root agnostic (works under %LOCALAPPDATA%, Program
 * Files, or a portable install).
 *
 * FAIL-CLOSED CONTRACT: a companion listed here must NEVER be killed when the
 * executable path is unavailable or does not contain the fragment. The engine
 * enforces this — see matchesImageName() in src/main/processKiller.js.
 */
const APP_COMPANION_SCOPES = {
  // Squirrel updater/relauncher, scoped to each vendor's own install directory.
  "discord.exe": { "update.exe": "\\discord\\" },
  "slack.exe": { "update.exe": "\\slack\\" },
  // Classic Teams (the new client uses ms-teamsupdate.exe, handled above).
  "teams.exe": { "update.exe": "\\microsoft\\teams\\" },
};

/**
 * Companion image names that are only safe to kill within a path scope.
 * Derived from APP_COMPANION_SCOPES so the two cannot drift.
 */
const SCOPED_COMPANION_NAMES = new Set(
  Object.values(APP_COMPANION_SCOPES).flatMap((m) => Object.keys(m))
);

/**
 * Required executable-path fragment for a companion of a given app.
 * @param {string} processName - the blocked app being closed
 * @param {string} companionName - the companion about to be terminated
 * @returns {string|null} lowercase path fragment, or null if no scope applies
 */
function getCompanionScope(processName, companionName) {
  const app = String(processName || "").toLowerCase();
  const companion = String(companionName || "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(APP_COMPANION_SCOPES, app)) {
    return null;
  }
  const scopes = APP_COMPANION_SCOPES[app];
  return Object.prototype.hasOwnProperty.call(scopes, companion) ? scopes[companion] : null;
}

/**
 * True if this image name may ONLY be killed inside a path scope. Used by the
 * engine to refuse a kill when it has a scoped name but no path to check it
 * against, rather than falling back to an unscoped image-name kill.
 * @param {string} companionName
 * @returns {boolean}
 */
function requiresPathScope(companionName) {
  return SCOPED_COMPANION_NAMES.has(String(companionName || "").toLowerCase());
}

// ─── Display Name Lookup ─────────────────────────────────────────────────────

/** Maps process executable names to human-friendly display names. */
const APP_DISPLAY_NAMES = {
  // Meeting
  "zoom.exe": "Zoom",
  "zoom.app": "Zoom",
  "zoom.us.app": "Zoom",
  "teams.exe": "Microsoft Teams",
  "teams.app": "Microsoft Teams",
  "microsoft teams.app": "Microsoft Teams",
  "ms-teams.exe": "Microsoft Teams",
  "msteams.exe": "Microsoft Teams",
  "webex.exe": "Webex",
  "webex.app": "Webex",
  "webex meetings.app": "Webex",
  "skype.exe": "Skype",
  "skype.app": "Skype",
  "gotomeeting.exe": "GoToMeeting",
  "gotomeeting.app": "GoToMeeting",
  // Screen Sharing / Recording
  "obs64.exe": "OBS Studio",
  "obs32.exe": "OBS Studio",
  "obs-studio.exe": "OBS Studio",
  "obs.app": "OBS Studio",
  "obs studio.app": "OBS Studio",
  "discord.exe": "Discord",
  "discord.app": "Discord",
  "slack.exe": "Slack",
  "slack.app": "Slack",
  "anydesk.exe": "AnyDesk",
  "anydesk.app": "AnyDesk",
  "teamviewer.exe": "TeamViewer",
  "teamviewer.app": "TeamViewer",
  "bandicam.exe": "Bandicam",
  "camtasia.exe": "Camtasia",
  "camtasia.app": "Camtasia",
  "snagit.exe": "Snagit",
  "snagit.app": "Snagit",
  // Casting / Mirroring
  "scrcpy.exe": "Scrcpy (Screen Mirror)",
  scrcpy: "Scrcpy (Screen Mirror)",
  "miracast.exe": "Miracast",
  "apowermirror.exe": "ApowerMirror",
  "apowermirror.app": "ApowerMirror",
  "letsview.exe": "LetsView",
  "letsview.app": "LetsView",
  // Browsers
  "chrome.exe": "Google Chrome",
  "google chrome.app": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "microsoft edge.app": "Microsoft Edge",
  "firefox.exe": "Firefox",
  "firefox.app": "Firefox",
  "safari.app": "Safari",
  "opera.exe": "Opera",
  "opera.app": "Opera",
  "brave.exe": "Brave",
  "brave.app": "Brave",
  "vivaldi.exe": "Vivaldi",
  "vivaldi.app": "Vivaldi",
  // AI Cheating Tools
  "pmodule.exe": "Parakeet AI",
  "pmodule.app": "Parakeet AI",
  "parakeet.exe": "Parakeet AI",
  "parakeetai.exe": "Parakeet AI",
  "parakeet.app": "Parakeet AI",
  "parakeetai.app": "Parakeet AI",
  "finalroundai.exe": "Final Round AI",
  "final round ai.exe": "Final Round AI",
  "finalround.exe": "Final Round AI",
  "final round ai.app": "Final Round AI",
  "finalroundai.app": "Final Round AI",
  "interviewcoder.exe": "InterviewCoder",
  "interview-coder.exe": "InterviewCoder",
  "interviewcoder.app": "InterviewCoder",
  "cluely.exe": "Cluely",
  "cluely.app": "Cluely",
  "lockedinai.exe": "LockedIn AI",
  "lockedin.exe": "LockedIn AI",
  "locked-in.exe": "LockedIn AI",
  "lockedinai.app": "LockedIn AI",
  "lockedin ai.app": "LockedIn AI",
  "sensei.exe": "Sensei AI",
  "sensaiai.exe": "Sensei AI",
  "sensai.app": "Sensei AI",
  "interviewsolver.exe": "Interview Solver",
  "interview-solver.exe": "Interview Solver",
  "interviewsolver.app": "Interview Solver",
  "interviewman.exe": "InterviewMan",
  "aceround.exe": "AceRound",
  "hedy.exe": "Hedy AI",
  "hedyai.exe": "Hedy AI",
};

/**
 * Returns a friendly display name for the given process name,
 * falling back to the raw process name if not found.
 * @param {string} processName
 * @returns {string}
 */
function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

module.exports = {
  MEETING_APPS,
  SCREEN_SHARING_APPS,
  CASTING_APPS,
  BROWSER_APPS,
  AI_CHEATING_APPS,
  ALL_BLOCKED_APPS,
  APP_DISPLAY_NAMES,
  getDisplayName,
  APP_COMPANIONS,
  getCompanions,
  APP_COMPANION_SCOPES,
  getCompanionScope,
  requiresPathScope,
};
