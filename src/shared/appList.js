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
  "pmodule.exe",            // Parakeet AI (real process name)
  "parakeet.exe", "parakeetai.exe",
  "finalroundai.exe", "final round ai.exe", "finalround.exe",
  "interviewcoder.exe", "interview-coder.exe",
  "cluely.exe",
  "lockedinai.exe", "lockedin.exe", "locked-in.exe",
  "sensei.exe", "sensaiai.exe",
  "interviewsolver.exe", "interview-solver.exe",
  "interviewman.exe",
  "aceround.exe",
  "hedy.exe", "hedyai.exe",
  // macOS
  "pmodule.app",
  "parakeet.app", "parakeetai.app",
  "final round ai.app", "finalroundai.app",
  "interviewcoder.app",
  "cluely.app",
  "lockedinai.app", "lockedin ai.app",
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
  "scrcpy": "Scrcpy (Screen Mirror)",
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
};
