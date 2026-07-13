/**
 * src/renderer/preflight.js
 * ─────────────────────────
 * Preflight security check UI controller.
 *
 * Communicates with the main process via window.electronAPI (contextBridge).
 * App lists and display names are sourced from shared/appList.js.
 */

"use strict";

// NOTE: In Electron's renderer (sandboxed), Node require() is not available.
// The shared data below is inlined at build time OR can be loaded via a
// bundler. For now it mirrors shared/appList.js directly.
// If you add a bundler (e.g. esbuild), replace with: require('../shared/appList')

let MEETING_APPS = [];
let SCREEN_SHARING_APPS = [];
let AI_CHEATING_APPS = [];
let APP_DISPLAY_NAMES = {};

function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

// ─── Icon Templates ───────────────────────────────────────────────────────────

const ICONS = {
  loading:
    '<svg class="sc-icon spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
  success:
    '<svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
  error:
    '<svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>',
};

// ─── State ──────────────────────────────────────────────────────────────────────────────

// True once preflight has fully passed — gates the live pre-proceed watcher.
let _proceedReady = false;

// Robustness guards (see runScans / showScanError / scheduleAutoRescan):
//   _scanRetryCount  — consecutive failed scans auto-retried (F2, capped)
//   _autoRescanCount — consecutive kill→rescan cycles auto-triggered (F3, capped)
//   _isAutoRescan    — set right before a PROGRAMMATIC rescan so a manual click
//                      resets the caps while an auto one preserves them
const SCAN_TIMEOUT_MS = 20000;
const MAX_SCAN_RETRIES = 3;
const MAX_AUTO_RESCANS = 3;
let _scanRetryCount  = 0;
let _autoRescanCount = 0;
let _isAutoRescan    = false;

const PROCEED_ENABLED_CLASS  = "sc-btn-proceed sc-btn-proceed--enabled";
const PROCEED_DISABLED_CLASS = "sc-btn-proceed sc-btn-proceed--disabled";

/** Rejects if `promise` doesn't settle within `ms` — bounds a hung native scan. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label || "Operation timed out")), ms)
    ),
  ]);
}

/**
 * Schedules a programmatic rescan after a kill, but caps the number of
 * consecutive auto-rescans so a self-relaunching app (some meeting/updater
 * apps restart themselves) can't create an endless kill→rescan→kill loop.
 */
function scheduleAutoRescan() {
  const finalStatus = document.getElementById("final-status");
  if (_autoRescanCount >= MAX_AUTO_RESCANS) {
    if (finalStatus) {
      finalStatus.className = "sc-status sc-status--fail";
      finalStatus.textContent =
        "Some apps keep reopening. Close them manually, then click Rescan.";
    }
    return;
  }
  _autoRescanCount += 1;
  setTimeout(() => {
    _isAutoRescan = true;
    document.getElementById("btn-rescan")?.click();
  }, 2000);
}

// ─── DOM References ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const btnRescan  = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");

  if (window.electronAPI) {
    try {
      const appList = await window.electronAPI.getAppList();
      MEETING_APPS = appList.meetingApps;
      SCREEN_SHARING_APPS = appList.screenSharingApps;
      AI_CHEATING_APPS = appList.aiCheatingApps || [];
      APP_DISPLAY_NAMES = appList.displayNames;
    } catch (e) {
      console.error("Failed to load app list", e);
    }
  }

  // ── App version footer ─────────────────────────────────────────────────────
  if (window.electronAPI?.getAppVersion) {
    window.electronAPI.getAppVersion().then((v) => {
      const el = document.getElementById("app-version");
      if (el && v) { el.textContent = `v${v}`; }
    }).catch(() => {});
  }

  // ── Auto-updater card (consent-first; interview-safe — main gates everything) ─
  if (window.electronAPI?.onUpdateAvailable) {
    window.electronAPI.onUpdateAvailable((data) =>
      setUpdateCard({
        kind: "available",
        version: data?.version,
        sizeBytes: data?.sizeBytes ?? null,
        releaseNotes: data?.releaseNotes ?? null,
      })
    );
    window.electronAPI.onUpdateProgress?.((data) =>
      setUpdateCard({
        kind: "downloading",
        percent: data?.percent ?? 0,
        transferred: data?.transferred ?? null,
        total: data?.total ?? null,
      })
    );
    window.electronAPI.onUpdateDownloaded((data) =>
      setUpdateCard({ kind: "downloaded", version: data?.version })
    );
    window.electronAPI.onUpdateError?.(({ error }) => {
      // Update-check failures (no release yet, offline, feed parse) are NOT
      // candidate-actionable and must never interrupt the preflight. Log only.
      console.warn("[updater] background update check failed (ignored):", error);
    });

    // Recovery: pull the current updater state in case an event fired before
    // these listeners attached (e.g. after a Recheck reloaded the page).
    window.electronAPI.getUpdateState?.().then((s) => {
      if (!s) { return; }
      if (s.downloaded) {
        setUpdateCard({ kind: "downloaded", version: s.version });
      } else if (s.state === "downloading") {
        setUpdateCard({ kind: "downloading", percent: s.percent, version: s.version });
      } else if (s.state === "available") {
        setUpdateCard({ kind: "available", version: s.version, sizeBytes: s.sizeBytes, releaseNotes: s.releaseNotes });
      }
    }).catch(() => {});
  }

  // ── Live blocked-app gating of the Proceed button ──────────────────────────
  // The pre-proceed watcher (main) pushes {clean, apps} every 2s while the user
  // is on the success screen. Without this, a candidate who passes preflight then
  // launches Zoom/OBS before clicking Proceed would still see Proceed enabled.
  window.electronAPI?.onPreProceedStatus?.(({ clean, apps }) => {
    if (!_proceedReady) { return; } // only gate once preflight has passed
    applyLiveProceedStatus(clean, apps || [], btnProceed, finalStatus);
  });

  // ── Scan Lifecycle ──────────────────────────────────────────────────────

  async function runScans() {
    // A manual rescan (user click) is a fresh start — clear the retry/rescan
    // caps. A programmatic rescan (auto-retry or post-kill) preserves them so
    // the caps actually bound the loop.
    if (!_isAutoRescan) {
      _scanRetryCount = 0;
      _autoRescanCount = 0;
    }
    _isAutoRescan = false;

    setLoadingState(btnProceed, btnRescan, finalStatus);

    if (!window.electronAPI) {
      // Non-Electron preview fallback
      setTimeout(() => setMockPassedState(finalStatus, btnProceed), 1000);
      return;
    }

    // ADD-02: Subscribe to per-step progress before invoking the scan.
    // Each card updates as soon as its check finishes — not all at the end.
    window.electronAPI.onPreflightProgress(({ step, status, result }) => {
      if (status === "done") {
        applyStepResult(step, result);
      }
      // 'running' — cards already show shimmer from setLoadingState; no action needed
    });

    try {
      // F1: bound the scan — a hung native check must never leave the page
      // stuck on "Scanning" forever with no way out.
      const results = await withTimeout(
        window.electronAPI.runPreflight(),
        SCAN_TIMEOUT_MS,
        "Security scan timed out"
      );
      // Cards were already updated via streaming events above.
      // processResults() re-applies them (idempotent) and sets the final button state.
      processResults(results, btnProceed, btnRescan, finalStatus);
      _scanRetryCount = 0; // a completed scan (pass or fail) breaks the retry chain
    } catch (err) {
      console.error("[preflight] scan error:", err);
      // IMP-15: Structured error boundary with capped auto-retry countdown
      showScanError(finalStatus, btnRescan, err?.message || "Unknown error");
    } finally {
      // Always clean up the listener to prevent leaks on rescan
      window.electronAPI.removePreflightProgressListener?.();
    }
  }

  // ── Button Listeners ──────────────────────────────────────────────────────

  btnRescan.addEventListener("click", runScans);

  const proceedBtnHTML = btnProceed.innerHTML; // capture original for restore
  btnProceed.addEventListener("click", () => {
    if (btnProceed.disabled) { return; }
    // Fail loud if the bridge method is missing — never spin forever silently
    // (synced with the other nav buttons hardened in renderer-production-hardening).
    if (typeof window.electronAPI?.loadPermissionsPage !== "function") {
      finalStatus.textContent = "Unable to continue — please restart the app.";
      finalStatus.className = "sc-status sc-status--fail";
      return;
    }
    btnProceed.disabled = true;
    btnProceed.className = "sc-btn-proceed sc-btn-proceed--loading";
    btnProceed.innerHTML = `${ICONS.loading} Loading...`;
    window.electronAPI.loadPermissionsPage();
    // Watchdog: successful navigation tears down this page (timer dies with it).
    // If it fires, navigation never happened — restore the button for a retry.
    setTimeout(() => {
      btnProceed.innerHTML = proceedBtnHTML;
      btnProceed.className = PROCEED_ENABLED_CLASS;
      btnProceed.disabled = false;
      finalStatus.textContent = "That took too long. Please try again.";
      finalStatus.className = "sc-status sc-status--fail";
    }, 6000);
  });

  // ── Initial Scan ──────────────────────────────────────────────────────────
  runScans();
});

// ─── Loading State ────────────────────────────────────────────────────────────

function setLoadingState(btnProceed, btnRescan, finalStatus) {
  btnProceed.disabled = true;
  btnProceed.className = "sc-btn-proceed sc-btn-proceed--loading";
  btnRescan.disabled = true;
  finalStatus.textContent = "Running security diagnostics...";
  finalStatus.className = "sc-status";

  ["hdmi", "meeting", "screen", "wireless", "ai"].forEach((id) => {
    const iconEl = document.getElementById(`icon-${id}`);
    const badgeEl = document.getElementById(`badge-${id}`);
    const actionsEl = document.getElementById(`actions-${id}`);

    if (iconEl) {
      iconEl.innerHTML = ICONS.loading;
      iconEl.className = "sc-card__icon";
    }
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--scanning";
      badgeEl.textContent = "Scanning";
    }
    if (actionsEl) { actionsEl.innerHTML = ""; }
  });

  // Show the agent card in a pending/scanning state (like the static cards)
  // until its result arrives. renderAgentCard() replaces it with pass/fail.
  renderAgentPending();
}

// ─── Agent Pending State ────────────────────────────────────────────────────

/**
 * Renders the Deep Scan Agent card in a scanning state, matching the static
 * cards. Without this the agent card was absent during the scan and popped in
 * already resolved; now it shows "Scanning" first, then pass/fail.
 */
function renderAgentPending() {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".sc-cards");
  if (!container) { return; }

  const card = document.createElement("div");
  card.id = "card-agent";
  card.className = "sc-card";
  card.innerHTML = `
    <div class="sc-card__row">
      <div class="sc-card__row-left">
        <div class="sc-card__icon">${ICONS.loading}</div>
        <div class="sc-card__body">
          <h3 class="sc-card__title">Deep Scan Agent</h3>
          <p class="sc-card__desc">Running deep behavioral scan…</p>
        </div>
      </div>
      <div class="sc-badge sc-badge--scanning">Scanning</div>
    </div>`;
  container.appendChild(card);
}

// ─── Results Processing ───────────────────────────────────────────────────────

/**
 * ADD-02: Apply a single step's result to its cards immediately.
 * Called both from the streaming progress listener AND from processResults()
 * (idempotent — calling twice with the same data is harmless).
 *
 * @param {string} step  - 'hdmi' | 'mirror' | 'agent'
 * @param {object} result - the result object for that step
 * @returns {boolean}    - true if this step passed (used by processResults allPassed)
 */
function applyStepResult(step, result) {
  switch (step) {
    case "hdmi":
      // Fail-CLOSED: on a security gate a missing result must never count as a
      // pass. If main omitted this check, surface it and block Proceed.
      if (!result) {
        updateCard("hdmi", false, "Could not verify external displays. Click Rescan.");
        return false;
      }
      if (result.detected) {
        updateCard("hdmi", false, "Disconnect all external displays/cables.");
        return false;
      }
      updateCard("hdmi", true, "No external display detected.");
      return true;

    case "mirror": {
      // Fail-CLOSED: the mirror scan drives the meeting/screen/wireless/ai cards.
      // A missing result blocks Proceed rather than silently passing all four.
      if (!result) {
        ["meeting", "screen", "wireless", "ai"].forEach((c) =>
          updateCard(c, false, "Could not complete this check. Click Rescan.")
        );
        return false;
      }
      const procs        = result.details?.processes || [];

      const foundMeeting = procs.filter((p) => MEETING_APPS.includes(p));
      const foundScreen  = procs.filter((p) => SCREEN_SHARING_APPS.includes(p));
      const foundAi      = procs.filter((p) => AI_CHEATING_APPS.includes(p));
      const foundOther   = procs.filter((p) => !MEETING_APPS.includes(p) && !SCREEN_SHARING_APPS.includes(p) && !AI_CHEATING_APPS.includes(p));

      if (foundMeeting.length > 0) {
        updateCard("meeting", false, "These meeting apps are still running:", foundMeeting);
      } else {
        updateCard("meeting", true, "No meeting apps detected.");
      }

      if (foundScreen.length > 0) {
        updateCard("screen", false, "These screen sharing apps are still running:", foundScreen);
      } else {
        updateCard("screen", true, "No screen sharing detected.");
      }

      if (foundAi.length > 0) {
        updateCard("ai", false, "These AI copilot tools are still running:", foundAi);
      } else {
        updateCard("ai", true, "No AI cheating tools detected.");
      }

      const wirelessFailed =
        foundOther.length > 0 ||
        (result.detected && foundMeeting.length === 0 && foundScreen.length === 0 && foundAi.length === 0);

      if (wirelessFailed) {
        if (foundOther.length > 0) {
          updateCard("wireless", false, "These remote/casting apps are still running:", foundOther);
        } else {
          updateCard("wireless", false, "Suspicious resolution detected — possible screen mirroring.");
        }
      } else {
        updateCard("wireless", true, "No casting/mirroring detected.");
      }

      return !(foundMeeting.length > 0 || foundScreen.length > 0 || foundAi.length > 0 || wirelessFailed);
    }

    case "agent":
      return renderAgentCard(result);

    default:
      return true;
  }
}

/**
 * Called once all checks are complete. Applies step results (idempotent with
 * streaming) and sets the final proceed button + status message.
 */
function processResults(results, btnProceed, btnRescan, finalStatus) {
  // Apply each step (cards may already be updated via streaming — idempotent)
  const hdmiPassed    = applyStepResult("hdmi",   results.hdmi);
  const mirrorPassed  = applyStepResult("mirror", results.mirror);
  const agentPassed   = applyStepResult("agent",  results.agent);

  // Since mirror handles meeting, screen, AI, and wireless, we just check mirrorPassed
  const allPassed = hdmiPassed && mirrorPassed && agentPassed;

  btnRescan.disabled = false;
  // Gate the live pre-proceed watcher: only react to it once preflight passed.
  _proceedReady = allPassed;

  if (allPassed) {
    _autoRescanCount = 0; // the kill→rescan loop resolved — re-arm auto-rescan
    finalStatus.textContent = "All security checks passed. You are ready to start.";
    finalStatus.className = "sc-status sc-status--pass";
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    finalStatus.textContent = "Please resolve the security alerts above to proceed.";
    finalStatus.className = "sc-status sc-status--fail";
    btnProceed.disabled = true;
    btnProceed.className = PROCEED_DISABLED_CLASS;
  }
}

/**
 * Live gating of the Proceed button from the pre-proceed watcher: if a blocked
 * app is launched after preflight passes but before the user clicks Proceed,
 * disable Proceed again; re-enable when the screen is clean.
 */
function applyLiveProceedStatus(clean, apps, btnProceed, finalStatus) {
  if (clean) {
    finalStatus.textContent = "All security checks passed. You are ready to start.";
    finalStatus.className = "sc-status sc-status--pass";
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    const names = apps.map((p) => getDisplayName(p)).join(", ");
    finalStatus.textContent = `A blocked app was launched: ${names}. Close it to proceed.`;
    finalStatus.className = "sc-status sc-status--fail";
    btnProceed.disabled = true;
    btnProceed.className = PROCEED_DISABLED_CLASS;
  }
}

// ─── Card Updates ─────────────────────────────────────────────────────────────

function updateCard(id, passed, msg, blockedApps = []) {
  const cardEl = document.getElementById(`card-${id}`);
  const iconEl = document.getElementById(`icon-${id}`);
  const descEl = document.getElementById(`desc-${id}`);
  const actionsEl = document.getElementById(`actions-${id}`);
  const badgeEl = document.getElementById(`badge-${id}`);

  if (actionsEl) {actionsEl.innerHTML = "";}

  if (passed) {
    cardEl.className = "sc-card";
    iconEl.innerHTML = ICONS.success;
    iconEl.className = "sc-card__icon sc-card__icon--pass";
    descEl.textContent = msg;
    descEl.className = "sc-card__desc";
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--pass";
      badgeEl.textContent = "Ready";
    }
  } else {
    cardEl.className = "sc-card sc-card--fail";
    iconEl.innerHTML = ICONS.error;
    iconEl.className = "sc-card__icon sc-card__icon--fail";
    descEl.textContent = msg;
    descEl.className = "sc-card__desc sc-card__desc--fail";
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--fail";
      badgeEl.textContent = "Action Required";
    }

    if (blockedApps.length > 0) {
      renderKillButtons(actionsEl, blockedApps);
    }
  }
}

// ─── Kill Buttons ─────────────────────────────────────────────────────────────

function renderKillButtons(container, blockedApps) {
  blockedApps.forEach((appName) => {
    const row = document.createElement("div");
    row.className = "sc-kill-row";

    // appName is a live OS process name — attacker-influenceable (a candidate
    // can rename an executable to an HTML payload). Escape before innerHTML.
    const safeDisplay = escapeHtml(getDisplayName(appName));
    const safeProcess = escapeHtml(appName);

    row.innerHTML = `
      <div class="sc-kill-info-wrap">
        <span class="sc-kill-indicator">
          <span class="sc-kill-ping"></span>
          <span class="sc-kill-dot"></span>
        </span>
        <div class="sc-kill-info">
          <span class="sc-kill-name">${safeDisplay}</span>
          <span class="sc-kill-process">${safeProcess}</span>
        </div>
      </div>`;

    const btn = document.createElement("button");
    btn.className = "sc-kill-btn";
    btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Close ${safeDisplay}`;
    btn.addEventListener("click", () => handleKillApp(btn, appName, row));

    row.appendChild(btn);
    container.appendChild(row);
  });

  if (blockedApps.length > 1) {
    const closeAllBtn = document.createElement("button");
    closeAllBtn.className = "sc-kill-all-btn";
    closeAllBtn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Close All & Re-scan`;
    closeAllBtn.addEventListener("click", () =>
      handleKillAll(closeAllBtn, blockedApps)
    );
    container.appendChild(closeAllBtn);
  }
}

// ─── Kill Handlers ────────────────────────────────────────────────────────────

async function handleKillApp(btn, processName, row) {
  btn.disabled = true;
  btn.className = "sc-kill-btn sc-kill-btn--killing";
  btn.innerHTML = `<svg class="sc-icon-xs spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing...`;

  try {
    const result = await window.electronAPI.killProcess(processName);

    if (result.success) {
      btn.className = "sc-kill-btn sc-kill-btn--killed";
      btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> Closed`;

      row.classList.add("sc-kill-row--closed");
      row.querySelector(".sc-kill-ping")?.remove();
      const dot = row.querySelector(".sc-kill-dot");
      if (dot) { dot.className = "sc-kill-dot sc-kill-dot--closed"; }

      // F4: derive "all closed" from the live DOM (rows still open across every
      // card) rather than a running counter that drifts on the fail-closed path.
      const stillOpen = document.querySelectorAll(
        ".sc-kill-row:not(.sc-kill-row--closed)"
      ).length;
      if (stillOpen === 0) {
        scheduleAutoRescan();
      }
    } else {
      btn.className = "sc-kill-btn sc-kill-btn--failed";
      btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> Failed — close ${escapeHtml(getDisplayName(processName))} manually`;
      btn.disabled = false;
    }
  } catch {
    btn.className = "sc-kill-btn sc-kill-btn--failed";
    btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> Error — close ${escapeHtml(getDisplayName(processName))} manually`;
    btn.disabled = false;
  }
}

async function handleKillAll(btn, processNames) {
  btn.disabled = true;
  btn.className = "sc-kill-all-btn sc-kill-all-btn--killing";
  btn.innerHTML = `<svg class="sc-icon-sm spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing all apps...`;

  try {
    await window.electronAPI.killAllProcesses(processNames);
    btn.className = "sc-kill-all-btn sc-kill-all-btn--success";
    btn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> All apps closed — re-scanning...`;
  } catch {
    btn.className = "sc-kill-all-btn sc-kill-all-btn--failed";
    btn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> Some apps failed to close`;
  }

  scheduleAutoRescan();
}

// ─── Agent Card ───────────────────────────────────────────────────────────────

function renderAgentCard(agent) {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".sc-cards");
  if (!container) { return true; }

  const card = document.createElement("div");
  card.id = "card-agent";

  if (!agent || !agent.alive) {
    card.className = "sc-card sc-card--fail";
    card.innerHTML = `
      <div class="sc-card__row">
        <div class="sc-card__row-left">
          <div class="sc-card__icon sc-card__icon--fail">
            <svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div class="sc-card__body">
            <h3 class="sc-card__title">Deep Scan Agent</h3>
            <p class="sc-card__desc sc-card__desc--fail">Security agent failed to start — it is required to continue. Click Re-scan to retry.</p>
          </div>
        </div>
        <div class="sc-badge sc-badge--fail">Required</div>
      </div>`;
    container.appendChild(card);
    return false;
  }

  const threats = agent.status?.threats || [];

  if (threats.length === 0) {
    card.className = "sc-card";
    card.innerHTML = `
      <div class="sc-card__row">
        <div class="sc-card__row-left">
          <div class="sc-card__icon sc-card__icon--pass">
            <svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
          <div class="sc-card__body">
            <h3 class="sc-card__title">Deep Scan Agent</h3>
            <p class="sc-card__desc">No AI tools, network anomalies, or automation frameworks detected.</p>
          </div>
        </div>
        <div class="sc-badge sc-badge--pass">Ready</div>
      </div>`;
    container.appendChild(card);
    return true;
  }

  card.className = "sc-card sc-card--fail";

  const threatRows = threats
    .map(
      (t) => `
    <div class="sc-threat-row">
      <span class="sc-kill-indicator">
        <span class="sc-kill-ping"></span>
        <span class="sc-kill-dot"></span>
      </span>
      <div class="sc-threat-content">
        <span class="sc-threat-title">${escapeHtml(t.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))}</span>
        <p class="sc-threat-detail">${escapeHtml(t.detail)}</p>
      </div>
      <span class="sc-threat-badge sc-threat-badge--${t.severity === "HIGH" ? "high" : "medium"}">${escapeHtml(t.severity)}</span>
    </div>`
    )
    .join("");

  card.innerHTML = `
    <div class="sc-card__row">
      <div class="sc-card__row-left">
        <div class="sc-card__icon sc-card__icon--fail">
          <svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </div>
        <div class="sc-card__body">
          <h3 class="sc-card__title">Deep Scan Agent</h3>
          <p class="sc-card__desc sc-card__desc--fail">
            ${threats.length} behavioral threat${threats.length > 1 ? "s" : ""} detected. Close the applications below and rescan.
          </p>
        </div>
      </div>
      <div class="sc-badge sc-badge--fail">Action Required</div>
    </div>
    <div class="sc-card__threats">${threatRows}</div>`;

  container.appendChild(card);
  return false;
}

// ─── Mock Fallback (non-Electron preview) ─────────────────────────────────────

function setMockPassedState(finalStatus, btnProceed) {
  ["hdmi", "meeting", "screen", "wireless", "ai"].forEach((id) =>
    updateCard(id, true, "Check passed (preview mode).")
  );
  finalStatus.textContent = "Preview mode — all checks simulated as passed.";
  btnProceed.disabled = false;
}

// ─── Error Boundary (IMP-15) ─────────────────────────────────────────────────

/**
 * Displays a structured scan-failure message with an auto-retry countdown.
 * Replaces the silent "Error running diagnostics." grey text.
 * @param {HTMLElement} finalStatus
 * @param {HTMLButtonElement} btnRescan
 * @param {string} message
 */
function showScanError(finalStatus, btnRescan, message) {
  btnRescan.disabled = false;

  // F2: stop the auto-retry storm. After MAX_SCAN_RETRIES consecutive failures
  // stop counting down and leave a manual Rescan prompt instead of hammering
  // the backend forever.
  if (_scanRetryCount >= MAX_SCAN_RETRIES) {
    finalStatus.className = "sc-status sc-status--fail";
    finalStatus.textContent = `Diagnostics failed: ${message}. Please click Rescan to try again.`;
    return;
  }

  _scanRetryCount += 1;
  const attempt = `attempt ${_scanRetryCount}/${MAX_SCAN_RETRIES}`;
  let seconds = 5;

  finalStatus.className = "sc-status sc-status--warn";
  finalStatus.textContent = `Diagnostics failed: ${message} — retrying in ${seconds}s… (${attempt})`;

  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      _isAutoRescan = true; // preserve the retry cap across this programmatic rescan
      btnRescan.click();
    } else {
      finalStatus.textContent = `Diagnostics failed: ${message} — retrying in ${seconds}s… (${attempt})`;
    }
  }, 1000);
}

// ─── Auto-Updater Card ────────────────────────────────────────────────────────
// Consent-first, bottom-right floating card. The main process gates download and
// install (never during an interview); the renderer only reflects state and
// relays the user's choice. Update-check failures never render anything.

let _update = { kind: "idle", notesOpen: false };

/** Formats a byte count as a compact human string (e.g. "12.4 MB"). */
function formatBytes(bytes) {
  if (!bytes || bytes < 0) { return ""; }
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Escapes text for safe insertion into the DOM (release notes are remote). */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

window.__updateAction = (action) => {
  if (action === "install") {
    window.electronAPI?.installUpdate?.();
  } else if (action === "notes") {
    setUpdateCard({ notesOpen: !_update.notesOpen });
  } else if (action === "dismiss") {
    setUpdateCard({ kind: "idle" });
  }
};

function setUpdateCard(next) {
  _update = { ..._update, ...next };
  renderUpdateCard();
}

function renderUpdateCard() {
  const s = _update;
  const existing = document.getElementById("update-card");

  if (!s || s.kind === "idle") { existing?.remove(); return; }

  let card = existing;
  if (!card) {
    card = document.createElement("div");
    card.id = "update-card";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    document.body.appendChild(card);
  }

  card.className = "update-card";
  card.innerHTML = updateCardBody(s);
}

function updateCardBody(s) {
  const icon = {
    available: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
    downloading: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
    downloaded: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>',
  }[s.kind] || "";

  const head = (title, tone = "") => `
    <div class="update-card__head">
      <span class="update-card__icon ${tone}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg>
      </span>
      <span class="update-card__title">${title}</span>
      ${s.version ? `<span class="update-card__chip">v${escapeHtml(s.version)}</span>` : ""}
    </div>`;

  const notes = s.releaseNotes
    ? `<button class="update-card__notes-toggle" onclick="window.__updateAction('notes')">
         ${s.notesOpen ? "Hide" : "What’s new"}
       </button>
       ${s.notesOpen ? `<div class="update-card__notes">${escapeHtml(
         typeof s.releaseNotes === "string" ? s.releaseNotes : ""
       ).slice(0, 1200)}</div>` : ""}`
    : "";

  switch (s.kind) {
    case "available": {
      const size = s.sizeBytes ? ` (${formatBytes(s.sizeBytes)})` : "";
      return `
        ${head("Update available")}
        <p class="update-card__body">Downloading in the background${size}…</p>
        ${notes}`;
    }
    case "downloading": {
      const pct = Math.max(0, Math.min(100, s.percent ?? 0));
      const sizeLine = (s.transferred && s.total)
        ? `${formatBytes(s.transferred)} / ${formatBytes(s.total)}`
        : "";
      return `
        ${head("Downloading update")}
        <div class="update-card__progress"><div class="update-card__progress-bar" style="width:${pct}%"></div></div>
        <p class="update-card__meta"><span>${pct}%</span><span>${sizeLine}</span></p>`;
    }
    case "downloaded":
      return `
        ${head("Update ready", "update-card__icon--ok")}
        <p class="update-card__body">It installs automatically when you close the app.</p>
        <div class="update-card__actions">
          <button class="update-card__btn update-card__btn--primary" onclick="window.__updateAction('install')">Update now</button>
          <button class="update-card__btn update-card__btn--ghost" onclick="window.__updateAction('dismiss')">Dismiss</button>
        </div>
        <p class="update-card__hint">"Update now" closes the app and installs — reopen from your interview link.</p>`;
    default:
      return "";
  }
}

