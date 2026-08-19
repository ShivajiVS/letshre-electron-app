/**
 * Auto-update orchestration (GitHub releases via electron-updater).
 *
 * All update activity is gated on interview state — never check/download/install
 * while an interview is active. Updates download silently and install on the
 * next natural quit (autoInstallOnAppQuit) if the user doesn't restart now.
 */

"use strict";

const { autoUpdater } = require("electron-updater");
const logger = require("./logger");
const appState = require("./appState");
const { killAgent } = require("./agentManager");
const { getWindow, getIsInterviewActive } = require("./windowManager");
const { IPC, UPDATE_CHECK_INTERVAL_MS } = require("../shared/constants");

/** @type {"idle"|"checking"|"available"|"downloading"|"downloaded"|"error"} */
let state = "idle";
let latestInfo = null;
let lastError = null;
let periodicTimer = null;
let lastPercent = 0; // most recent download-progress %, for getState() recovery
// Sticky flag: an update has finished downloading and is staged on disk. Unlike
// `state` (which a later re-check can flip to "checking"/"idle"), this stays true
// until install/reset, so installUpdate() can't refuse a ready update.
let downloaded = false;

function send(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // window gone mid-send — ignore
    }
  }
}

function setState(next, extra = {}) {
  state = next;
  send(IPC.PUSH_UPDATE_STATE, {
    state,
    version: latestInfo?.version || null,
    ...extra,
  });
}

/**
 * Wires the updater. Call once during onReady (after the window exists so early
 * events can reach the renderer).
 */
function init() {
  // Disable electron-updater's own auto-download (no interview check) — we
  // trigger it ourselves via downloadUpdate(), which refuses mid-interview.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-updater accepts any logger with debug/info/warn/error — ours has all.
  autoUpdater.logger = logger;

  autoUpdater.on("checking-for-update", () => setState("checking"));

  autoUpdater.on("update-available", (info) => {
    // A periodic re-check re-emits this event for a version we've already staged
    // (electron-updater doesn't dedupe). Don't un-ready it and re-download.
    if (downloaded && latestInfo?.version === info.version) {
      logger.info("[updater] update-available for already-staged version — keeping ready state");
      return;
    }
    latestInfo = info;
    downloaded = false;
    logger.info("[updater] update available:", info.version);
    setState("available");
    send(IPC.PUSH_UPDATE_AVAILABLE, {
      version: info.version,
      releaseNotes: info.releaseNotes,
      // Total download size (bytes) so the card can show "ready to download (X MB)".
      sizeBytes: Array.isArray(info.files) && info.files[0] ? info.files[0].size : null,
    });
    // Auto-start the download — downloadUpdate() no-ops during an interview.
    downloadUpdate();
  });

  autoUpdater.on("update-not-available", () => {
    logger.info("[updater] no update available");
    setState("idle");
  });

  autoUpdater.on("download-progress", (p) => {
    const percent = Math.round(p.percent || 0);
    lastPercent = percent;
    setState("downloading", { percent });
    send(IPC.PUSH_UPDATE_PROGRESS, {
      percent,
      bytesPerSecond: p.bytesPerSecond,
      transferred: p.transferred,
      total: p.total,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    latestInfo = info;
    downloaded = true;
    logger.info("[updater] update downloaded, ready to install:", info.version);
    setState("downloaded");
    send(IPC.PUSH_UPDATE_DOWNLOADED, {
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("error", (err) => {
    lastError = err?.message || String(err);
    logger.warn("[updater] error:", lastError);
    setState("error", { error: lastError });
    send(IPC.PUSH_UPDATE_ERROR, { error: lastError });
  });

  // Initial check (safe — we're in preflight), then a gated periodic re-check.
  checkForUpdates();
  periodicTimer = setInterval(() => {
    if (!getIsInterviewActive()) {
      checkForUpdates();
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

/** Triggers a check unless an interview is active. */
function checkForUpdates() {
  if (getIsInterviewActive()) {
    logger.info("[updater] check skipped — interview active");
    return;
  }
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    logger.warn("[updater] checkForUpdates failed:", err.message);
  }
}

/**
 * Renderer-triggered download (user consented). Refuses during an interview so
 * a background download can never be kicked off mid-session.
 * @returns {boolean} whether the download was started.
 */
function downloadUpdate() {
  if (getIsInterviewActive()) {
    logger.warn("[updater] download blocked — interview active");
    return false;
  }
  if (state !== "available") {
    logger.warn("[updater] download requested but no update is available");
    return false;
  }
  logger.info("[updater] downloading update:", latestInfo?.version);
  autoUpdater
    .downloadUpdate()
    .catch((err) => logger.warn("[updater] downloadUpdate failed:", err.message));
  return true;
}

/**
 * Renderer-triggered "Restart & Update". Refuses during an active interview and
 * only acts when an update is actually downloaded.
 * @returns {boolean} whether the install was initiated.
 */
function installUpdate() {
  if (getIsInterviewActive()) {
    logger.warn("[updater] install blocked — interview active");
    send(IPC.PUSH_UPDATE_ERROR, {
      error: "Updates cannot be installed during an active interview.",
    });
    return false;
  }
  if (!downloaded) {
    logger.warn("[updater] install requested but no update is ready");
    return false;
  }
  logger.info("[updater] quitting to install update (silent):", latestInfo?.version);
  appState.setQuitting();

  // Kill the agent first so resources\agent.exe isn't locked when the installer
  // removes the old version (installer's customInit also force-kills it — belt
  // and suspenders against the race).
  try {
    killAgent();
  } catch (err) {
    logger.warn("[updater] killAgent before install failed:", err.message);
  }

  // Delay lets the OS release the agent's file handles first. No relaunch
  // (isForceRunAfter=false): the app opens via a letshyre:// deep link whose
  // token would be lost on relaunch, so candidates reopen from their interview
  // link instead. perMachine:false avoids a UAC prompt.
  setTimeout(() => autoUpdater.quitAndInstall(true, false), 1200);
  return true;
}

/**
 * Called when an interview ends — a safe moment to re-surface a held update or
 * re-check. A "Later" deferral still installs on the next quit.
 */
function onInterviewEnded() {
  if (state === "downloaded") {
    send(IPC.PUSH_UPDATE_DOWNLOADED, {
      version: latestInfo?.version || null,
      releaseNotes: latestInfo?.releaseNotes || null,
    });
  } else {
    checkForUpdates();
  }
}

/**
 * Current updater snapshot — the renderer pulls this on load to recover any
 * state/progress events it missed before its listeners were attached (e.g. after
 * a Recheck reloads the page). Returns enough to re-render the update card.
 */
function getState() {
  return {
    state,
    version: latestInfo?.version || null,
    releaseNotes: latestInfo?.releaseNotes || null,
    sizeBytes:
      Array.isArray(latestInfo?.files) && latestInfo.files[0] ? latestInfo.files[0].size : null,
    percent: lastPercent,
    downloaded,
    error: lastError,
  };
}

function dispose() {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

module.exports = {
  init,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  onInterviewEnded,
  getState,
  dispose,
};
