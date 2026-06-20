/**
 * src/main/updater.js
 * ───────────────────
 * Auto-update orchestration (GitHub releases via electron-updater).
 *
 * Design priorities for a PROCTORING client:
 *   1. INTERVIEW SAFETY — never check, prompt, or install while an interview is
 *      active. An auto-restart mid-session would void the interview. All update
 *      activity is gated on windowManager.getIsInterviewActive().
 *   2. Background download + DEFER — updates download silently and, if the user
 *      doesn't restart now, install automatically on the next natural quit
 *      (autoInstallOnAppQuit). The user is never forced to restart.
 *   3. Observable UX — the renderer receives state, progress, ready, and error
 *      events so it can show a friendly banner.
 *
 * Code signing is NOT required for Windows auto-update to function; when signing
 * secrets (CSC_LINK / CSC_KEY_PASSWORD) are added to the build, no code here
 * changes — electron-builder simply produces signed artifacts.
 */

"use strict";

const { app } = require("electron");
const { autoUpdater } = require("electron-updater");
const logger = require("./logger");
const appState = require("./appState");
const { killAgent } = require("./agentManager");
const { getWindow, getIsInterviewActive } = require("./windowManager");
const { IPC, UPDATE_CHECK_INTERVAL_MS } = require("../shared/constants");

/** @type {"idle"|"checking"|"available"|"downloading"|"downloaded"|"error"} */
let state = "idle";
let latestInfo = null; // last update info (version, releaseNotes)
let lastError = null;
let periodicTimer = null;

// ─── Renderer messaging ──────────────────────────────────────────────────────

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

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Wires the updater. Call once during onReady (after the window exists so early
 * events can reach the renderer).
 */
function init() {
  // CONSENT-FIRST: do not fetch bytes until the user clicks Download.
  autoUpdater.autoDownload = false;
  // A downloaded-but-deferred update installs on the next ordinary quit.
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-updater accepts any logger with debug/info/warn/error — ours has all.
  autoUpdater.logger = logger;

  autoUpdater.on("checking-for-update", () => setState("checking"));

  autoUpdater.on("update-available", (info) => {
    latestInfo = info;
    logger.info("[updater] update available:", info.version);
    setState("available");
    send(IPC.PUSH_UPDATE_AVAILABLE, {
      version: info.version,
      releaseNotes: info.releaseNotes,
      // Total download size (bytes) so the card can show "ready to download (X MB)".
      sizeBytes: Array.isArray(info.files) && info.files[0] ? info.files[0].size : null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    logger.info("[updater] no update available");
    setState("idle");
  });

  autoUpdater.on("download-progress", (p) => {
    const percent = Math.round(p.percent || 0);
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

// ─── Actions ─────────────────────────────────────────────────────────────────

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
  autoUpdater.downloadUpdate().catch((err) =>
    logger.warn("[updater] downloadUpdate failed:", err.message)
  );
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
  if (state !== "downloaded") {
    logger.warn("[updater] install requested but no update is ready");
    return false;
  }
  logger.info("[updater] quitting to install update (silent):", latestInfo?.version);
  appState.setQuitting();

  // Kill the bundled Python agent FIRST so resources\agent.exe is not locked
  // when the installer removes the old version (otherwise the uninstall fails
  // with "Failed to uninstall old application files"). The installer's
  // customInit hook also force-kills it, but doing it here too closes the race.
  try {
    killAgent();
  } catch (err) {
    logger.warn("[updater] killAgent before install failed:", err.message);
  }

  // Short delay so the OS releases the agent's file handles before the
  // installer launches. (isSilent=true, isForceRunAfter=true) → silent install
  // + relaunch, no wizard popup. perMachine:false avoids a UAC prompt.
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
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

/** Current updater snapshot — exposed to the renderer for initial banner state. */
function getState() {
  return { state, version: latestInfo?.version || null, error: lastError };
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
  getAppVersion: () => app.getVersion(),
};
