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
  "teams.exe": ["ms-teamsupdate.exe"],
  "ms-teams.exe": ["ms-teamsupdate.exe"],
  "msteams.exe": ["ms-teamsupdate.exe"],

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
};
