"use strict";

// Stand-in for preload.js: same window.electronAPI surface, but every call is
// relayed to the e2e test main, which answers from the running scenario.

const { contextBridge, ipcRenderer } = require("electron");

const INVOKE = [
  "login",
  "logout",
  "getAuthUser",
  "getCandidateProfile",
  "submitRole",
  "fetchProfileImage",
  "submitVoiceSample",
  "submitFaceVerification",
  "storeCandidatePhoto",
  "runPreflight",
  "killProcess",
  "killAllProcesses",
  "canElevate",
  "killProcessElevated",
  "killThreatProcess",
  "getSupportInfo",
  "getUpdateState",
  "getAppVersion",
  "getAuditLog",
  "getAppList",
  "startProctoring",
  "getLocale",
  "setLocale",
  "getTranslations",
  "getSupportedLocales",
  "getI18nBootstrap",
];

const SEND = [
  "startInterview",
  "loadPermissionsPage",
  "backToPermissions",
  "loadIdentityVerification",
  "loadRoleSelection",
  "loadHowItWorks",
  "retryInterview",
  "loadDashboard",
  "viewDashboard",
  "loadSecurityCheck",
  "loadLanguageSelection",
  "proceedToInterview",
  "quitApp",
  "recheckSystem",
  "minimizeWindow",
  "openSupport",
  "installUpdate",
  "acknowledgeViolation",
  "interviewComplete",
  "stopProctoring",
];

// Subscriptions replace the previous listener, as the real bridge does.
const SUBSCRIBE = {
  onUpdateAvailable: "push-update-available",
  onUpdateDownloaded: "push-update-downloaded",
  onUpdateProgress: "push-update-progress",
  onUpdateError: "push-update-error",
  onUpdateState: "push-update-state",
  onPreflightProgress: "preflight-progress",
  onWarning: "push-warning",
  onViolation: "push-violation",
  onProctoringStarted: "push-proctoring-started",
  onProctoringError: "push-proctoring-error",
  onPreProceedStatus: "push-pre-proceed-status",
  onLocaleChanged: "locale-changed",
};

const UNSUBSCRIBE = {
  removeUpdateAvailableListener: "push-update-available",
  removeUpdateDownloadedListener: "push-update-downloaded",
  removePreflightProgressListener: "preflight-progress",
  removeWarningListener: "push-warning",
  removeViolationListener: "push-violation",
  removePreProceedStatusListener: "push-pre-proceed-status",
  removeLocaleChangedListener: "locale-changed",
};

const listeners = new Map();

ipcRenderer.on("e2e:push", (_event, channel, data) => {
  const cb = listeners.get(channel);
  if (cb) {
    cb(data);
  }
});

const api = {};
INVOKE.forEach((name) => {
  api[name] = (...args) => ipcRenderer.invoke("e2e:invoke", name, args);
});
SEND.forEach((name) => {
  api[name] = (...args) => ipcRenderer.send("e2e:send", name, args);
});
Object.entries(SUBSCRIBE).forEach(([name, channel]) => {
  api[name] = (callback) => {
    listeners.set(channel, callback);
    ipcRenderer.send("e2e:send", name, []);
  };
});
Object.entries(UNSUBSCRIBE).forEach(([name, channel]) => {
  api[name] = () => {
    listeners.delete(channel);
    ipcRenderer.send("e2e:send", name, []);
  };
});

contextBridge.exposeInMainWorld("electronAPI", api);
