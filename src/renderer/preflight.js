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

// Only the display-name map is needed here now. Deciding WHICH category a
// running process falls into moved to src/detector/preflightVerdict.js in main,
// because that decision feeds `canProceed` — the renderer must not be the
// component that determines whether the machine is clean.
let APP_DISPLAY_NAMES = {};

function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
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
  // "Unverified" — deliberately a question mark, not a warning triangle. This
  // state means "we could not establish this", which is not the candidate's
  // fault; the triangle reads as an accusation.
  unknown:
    '<svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
};

// ─── Verdict contract ─────────────────────────────────────────────────────────
// Card state comes from main as { id, status, reasonKey, reasonParams,
// blockedApps, threats }. `unverified` blocks Proceed exactly like `fail` — the
// renderer never decides that an unestablished check is a pass.
// `fail` is the fallthrough branch in both card renderers, so it needs no
// constant here — but it is never the DEFAULT: an unrecognised status lands in
// the fail branch, which blocks Proceed. Fail-closed by construction.
const PASS = "pass";
const UNVERIFIED = "unverified";

/**
 * English fallbacks for verdict reason keys, used only when window.t is absent
 * (the non-Electron browser preview). In the app these always resolve through
 * i18n — main sends keys, not prose, so translations cannot drift from logic.
 */
const REASON_FALLBACK = {
  "preflightResults.hdmiClear": "No external display detected.",
  "preflightResults.hdmiDetected": "Disconnect all external displays/cables.",
  "preflightResults.hdmiUnverified": "Could not verify external displays. Click Re-scan.",
  "preflightResults.meetingClear": "No meeting apps detected.",
  "preflightResults.meetingRunning": "These meeting apps are still running:",
  "preflightResults.screenClear": "No screen sharing detected.",
  "preflightResults.screenRunning": "These screen sharing apps are still running:",
  "preflightResults.wirelessClear": "No casting/mirroring detected.",
  "preflightResults.wirelessRunning": "These remote/casting apps are still running:",
  "preflightResults.aiClear": "No AI cheating tools detected.",
  "preflightResults.aiRunning": "These AI copilot tools are still running:",
  "preflightResults.checkUnverified": "Could not verify this check. Click Re-scan.",
  "preflightResults.agentClear": "No AI tools, network anomalies, or automation frameworks detected.",
  "preflightResults.agentFailedStart": "Security agent failed to start — it is required to continue. Click Re-scan to retry.",
  "preflightResults.agentUnverified": "Deep scan did not complete — this device could not be verified. Click Re-scan.",
  "preflightResults.agentDegraded": "Deep scan finished with errors — this device could not be fully verified. Click Re-scan.",
  "preflightResults.agentThreatsDetected": "Behavioral threats detected. Close the applications below and rescan.",
};

/** Renders a verdict's reason through i18n, falling back to English in preview. */
function verdictText(v) {
  return tr(v.reasonKey, REASON_FALLBACK[v.reasonKey] || v.reasonKey, v.reasonParams);
}

// ─── State ──────────────────────────────────────────────────────────────────────────────

// True once preflight has fully passed — gates the live pre-proceed watcher.
let _proceedReady = false;

// Robustness guards (see runScans / showScanError / scheduleAutoRescan):
//   _scanRetryCount  — consecutive failed scans auto-retried (F2, capped)
//   _autoRescanCount — consecutive kill→rescan cycles auto-triggered (F3, capped)
//   _isAutoRescan    — set right before a PROGRAMMATIC rescan so a manual click
//                      resets the caps while an auto one preserves them
// Renderer-side abort. MIRRORS PREFLIGHT_RENDERER_TIMEOUT_MS in
// src/shared/constants.js — keep the two in sync (preload is sandboxed and
// cannot require local modules, same reason the IPC names are mirrored there).
// test/preflightBudget.test.js asserts they still match.
//
// This was 20000 while main's worst case was ~31s, so a cold agent spawn
// reliably aborted a scan that was progressing normally and kicked off the
// retry storm. Main is now bounded to PREFLIGHT_GLOBAL_DEADLINE_MS (10s), which
// this must exceed.
const SCAN_TIMEOUT_MS = 15000;
const MAX_SCAN_RETRIES = 3;
const MAX_AUTO_RESCANS = 3;
let _scanRetryCount  = 0;
let _autoRescanCount = 0;
let _isAutoRescan    = false;
/** Incremented per scan; progress events from older generations are ignored. */
let _scanGeneration  = 0;

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
        tr("preflightResults.appsReopening", "Some apps keep reopening. Close them manually, then click Rescan.");
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
  if (window.i18n?.ready) { await window.i18n.ready; }

  const btnRescan  = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");

  if (window.electronAPI) {
    try {
      const appList = await window.electronAPI.getAppList();
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

    // Generation guard. A renderer-side timeout abandons its invoke but cannot
    // cancel the work in main, so the abandoned scan keeps streaming progress
    // events. Without this they repaint the NEW scan's cards with stale results.
    const myGeneration = ++_scanGeneration;

    // Subscribe to per-verdict progress before invoking the scan, so each card
    // updates the moment its own check lands rather than all at the end.
    window.electronAPI.onPreflightProgress((verdict) => {
      if (myGeneration !== _scanGeneration) { return; } // superseded — drop it
      applyVerdict(verdict);
    });

    try {
      // Bound the scan so a hung native check can never leave the page stuck on
      // "Scanning" with no way out. This budget MUST stay larger than main's
      // PREFLIGHT_GLOBAL_DEADLINE_MS so that main is always the component which
      // decides a scan is over — see the invariant in src/shared/constants.js.
      const results = await withTimeout(
        window.electronAPI.runPreflight(),
        SCAN_TIMEOUT_MS,
        "Security scan timed out"
      );
      if (myGeneration !== _scanGeneration) { return; } // a newer scan owns the UI
      // Cards were already updated via streaming events above.
      // processResults() re-applies them (idempotent) and sets the final button state.
      processResults(results, btnProceed, btnRescan, finalStatus);
      _scanRetryCount = 0; // a completed scan (pass or fail) breaks the retry chain
    } catch (err) {
      if (myGeneration !== _scanGeneration) { return; }
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
      finalStatus.textContent = tr("preflightResults.restartApp", "Unable to continue — please restart the app.");
      finalStatus.className = "sc-status sc-status--fail";
      return;
    }
    btnProceed.disabled = true;
    btnProceed.className = "sc-btn-proceed sc-btn-proceed--loading";
    btnProceed.innerHTML = `${ICONS.loading} ${tr("preflightResults.loading", "Loading...")}`;
    window.electronAPI.loadPermissionsPage();
    // Watchdog: successful navigation tears down this page (timer dies with it).
    // If it fires, navigation never happened — restore the button for a retry.
    setTimeout(() => {
      btnProceed.innerHTML = proceedBtnHTML;
      btnProceed.className = PROCEED_ENABLED_CLASS;
      btnProceed.disabled = false;
      finalStatus.textContent = tr("preflightResults.tooLong", "That took too long. Please try again.");
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
  finalStatus.textContent = tr("preflight.runningDiagnostics", "Running security diagnostics...");
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
      badgeEl.textContent = tr("preflightResults.scanning", "Scanning");
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
          <h3 class="sc-card__title">${tr("preflightResults.agentTitle", "Deep Scan Agent")}</h3>
          <p class="sc-card__desc">${tr("preflightResults.runningDeepScan", "Running deep behavioral scan…")}</p>
        </div>
      </div>
      <div class="sc-badge sc-badge--scanning">${tr("preflightResults.scanning", "Scanning")}</div>
    </div>`;
  container.appendChild(card);
}

// ─── Results Processing ───────────────────────────────────────────────────────

/**
 * Renders one verdict onto its card. Called both from the streaming progress
 * listener and again from processResults() — idempotent, keyed by card id, so a
 * re-emit (e.g. the physical-monitor cross-check upgrading the HDMI verdict)
 * simply replaces the earlier render.
 *
 * @param {{id: string, status: string, reasonKey: string, reasonParams?: object,
 *          blockedApps?: string[], threats?: object[]}} v
 */
function applyVerdict(v) {
  if (!v || !v.id) { return; }
  if (v.id === "agent") {
    renderAgentCard(v);
    return;
  }
  updateCard(v.id, v.status, verdictText(v), v.blockedApps || []);
}

/**
 * Called once the scan completes. Re-applies every verdict (idempotent with the
 * streamed ones) and sets the final button + status.
 *
 * The Proceed gate is `results.canProceed`, computed in the MAIN process. The
 * renderer no longer derives it: main re-verifies the same value when the button
 * is actually clicked, so the two must come from one source.
 */
function processResults(results, btnProceed, btnRescan, finalStatus) {
  const verdicts = Array.isArray(results?.verdicts) ? results.verdicts : [];
  verdicts.forEach(applyVerdict);

  // Fail-CLOSED: a malformed or empty response never opens the gate.
  const allPassed = results?.canProceed === true && verdicts.length > 0;
  const anyUnverified = verdicts.some((v) => v.status === UNVERIFIED);

  btnRescan.disabled = false;
  // Gate the live pre-proceed watcher: only react to it once preflight passed.
  _proceedReady = allPassed;

  if (allPassed) {
    _autoRescanCount = 0; // the kill→rescan loop resolved — re-arm auto-rescan
    finalStatus.textContent = tr("preflightResults.allPassed", "All security checks passed. You are ready to start.");
    finalStatus.className = "sc-status sc-status--pass";
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    // Distinguish "you have something to close" from "we could not check".
    // Only the first is actionable by the candidate; telling someone to
    // "resolve the security alerts" when a probe failed sends them hunting for
    // a problem that isn't theirs.
    finalStatus.textContent = anyUnverified
      ? tr("preflightResults.someUnverified", "Some checks could not be verified. Click Re-scan to try again.")
      : tr("preflightResults.resolveAlerts", "Please resolve the security alerts above to proceed.");
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
    finalStatus.textContent = tr("preflightResults.allPassed", "All security checks passed. You are ready to start.");
    finalStatus.className = "sc-status sc-status--pass";
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    const names = apps.map((p) => getDisplayName(p)).join(", ");
    finalStatus.textContent = tr(
      "preflightResults.blockedAppLaunched",
      `A blocked app was launched: ${names}. Close it to proceed.`,
      { names }
    );
    finalStatus.className = "sc-status sc-status--fail";
    btnProceed.disabled = true;
    btnProceed.className = PROCEED_DISABLED_CLASS;
  }
}

// ─── Card Updates ─────────────────────────────────────────────────────────────

/**
 * Paints one static card in one of three states.
 *
 * `unverified` is visually distinct from `fail` on purpose: it blocks Proceed
 * just as hard, but it means "we could not establish this", not "you did
 * something wrong". It also carries no kill buttons — there is nothing for the
 * candidate to close, the check simply did not complete.
 *
 * @param {string} id
 * @param {"pass"|"fail"|"unverified"} status
 * @param {string} msg
 * @param {string[]} [blockedApps]
 */
function updateCard(id, status, msg, blockedApps = []) {
  const cardEl = document.getElementById(`card-${id}`);
  const iconEl = document.getElementById(`icon-${id}`);
  const descEl = document.getElementById(`desc-${id}`);
  const actionsEl = document.getElementById(`actions-${id}`);
  const badgeEl = document.getElementById(`badge-${id}`);
  if (!cardEl || !iconEl || !descEl) { return; }

  if (actionsEl) {actionsEl.innerHTML = "";}
  descEl.textContent = msg;

  if (status === PASS) {
    cardEl.className = "sc-card";
    iconEl.innerHTML = ICONS.success;
    iconEl.className = "sc-card__icon sc-card__icon--pass";
    descEl.className = "sc-card__desc";
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--pass";
      badgeEl.textContent = tr("preflightResults.ready", "Ready");
    }
    return;
  }

  if (status === UNVERIFIED) {
    cardEl.className = "sc-card sc-card--unverified";
    iconEl.innerHTML = ICONS.unknown;
    iconEl.className = "sc-card__icon sc-card__icon--unverified";
    descEl.className = "sc-card__desc sc-card__desc--unverified";
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--unverified";
      badgeEl.textContent = tr("preflightResults.unverified", "Unverified");
    }
    return;
  }

  cardEl.className = "sc-card sc-card--fail";
  iconEl.innerHTML = ICONS.error;
  iconEl.className = "sc-card__icon sc-card__icon--fail";
  descEl.className = "sc-card__desc sc-card__desc--fail";
  if (badgeEl) {
    badgeEl.className = "sc-badge sc-badge--fail";
    badgeEl.textContent = tr("preflightResults.actionRequired", "Action Required");
  }
  if (blockedApps.length > 0) {
    renderKillButtons(actionsEl, blockedApps);
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
    btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> ${tr("preflightResults.closeApp", `Close ${safeDisplay}`, { name: safeDisplay })}`;
    btn.addEventListener("click", () => handleKillApp(btn, appName, row));

    row.appendChild(btn);
    container.appendChild(row);
  });

  if (blockedApps.length > 1) {
    const closeAllBtn = document.createElement("button");
    closeAllBtn.className = "sc-kill-all-btn";
    closeAllBtn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> ${tr("preflightResults.closeAllRescan", "Close All & Re-scan")}`;
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
  btn.innerHTML = `<svg class="sc-icon-xs spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> ${tr("preflightResults.closing", "Closing...")}`;

  try {
    const result = await window.electronAPI.killProcess(processName);

    if (result.success) {
      btn.className = "sc-kill-btn sc-kill-btn--killed";
      btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> ${tr("preflightResults.closed", "Closed")}`;

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
      btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> ${tr("preflightResults.closeFailedManual", `Failed — close ${escapeHtml(getDisplayName(processName))} manually`, { name: escapeHtml(getDisplayName(processName)) })}`;
      btn.disabled = false;
    }
  } catch {
    btn.className = "sc-kill-btn sc-kill-btn--failed";
    btn.innerHTML = `<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> ${tr("preflightResults.closeErrorManual", `Error — close ${escapeHtml(getDisplayName(processName))} manually`, { name: escapeHtml(getDisplayName(processName)) })}`;
    btn.disabled = false;
  }
}

async function handleKillAll(btn, processNames) {
  btn.disabled = true;
  btn.className = "sc-kill-all-btn sc-kill-all-btn--killing";
  btn.innerHTML = `<svg class="sc-icon-sm spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> ${tr("preflightResults.closingAll", "Closing all apps...")}`;

  try {
    await window.electronAPI.killAllProcesses(processNames);
    btn.className = "sc-kill-all-btn sc-kill-all-btn--success";
    btn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> ${tr("preflightResults.allClosedRescanning", "All apps closed — re-scanning...")}`;
  } catch {
    btn.className = "sc-kill-all-btn sc-kill-all-btn--failed";
    btn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg> ${tr("preflightResults.someFailedToClose", "Some apps failed to close")}`;
  }

  scheduleAutoRescan();
}

// ─── Agent Card ───────────────────────────────────────────────────────────────

/**
 * Renders the Deep Scan Agent card from its verdict.
 *
 * Note the three distinct non-pass states, which the previous implementation
 * collapsed into two: an agent that answered ping but returned no scan used to
 * fall through to the "no threats" branch and render a green "Ready" badge,
 * claiming a clean device on the strength of a scan that never ran.
 *
 * @param {{status: string, reasonKey: string, reasonParams?: object, threats?: object[]}} v
 */
function renderAgentCard(v) {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".sc-cards");
  if (!container) { return; }

  const title = tr("preflightResults.agentTitle", "Deep Scan Agent");
  const desc = verdictText(v);
  const card = document.createElement("div");
  card.id = "card-agent";

  if (v.status === UNVERIFIED) {
    card.className = "sc-card sc-card--unverified";
    card.innerHTML = `
      <div class="sc-card__row">
        <div class="sc-card__row-left">
          <div class="sc-card__icon sc-card__icon--unverified">${ICONS.unknown}</div>
          <div class="sc-card__body">
            <h3 class="sc-card__title">${title}</h3>
            <p class="sc-card__desc sc-card__desc--unverified">${escapeHtml(desc)}</p>
          </div>
        </div>
        <div class="sc-badge sc-badge--unverified">${tr("preflightResults.unverified", "Unverified")}</div>
      </div>`;
    container.appendChild(card);
    return;
  }

  if (v.status === PASS) {
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
            <h3 class="sc-card__title">${title}</h3>
            <p class="sc-card__desc">${escapeHtml(desc)}</p>
          </div>
        </div>
        <div class="sc-badge sc-badge--pass">${tr("preflightResults.ready", "Ready")}</div>
      </div>`;
    container.appendChild(card);
    return;
  }

  const threats = v.threats || [];

  // Agent down: mandatory, and Re-scan respawns it.
  if (threats.length === 0) {
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
            <h3 class="sc-card__title">${title}</h3>
            <p class="sc-card__desc sc-card__desc--fail">${escapeHtml(desc)}</p>
          </div>
        </div>
        <div class="sc-badge sc-badge--fail">${tr("preflightResults.required", "Required")}</div>
      </div>`;
    container.appendChild(card);
    return;
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
          <h3 class="sc-card__title">${title}</h3>
          <p class="sc-card__desc sc-card__desc--fail">${escapeHtml(desc)}</p>
        </div>
      </div>
      <div class="sc-badge sc-badge--fail">${tr("preflightResults.actionRequired", "Action Required")}</div>
    </div>
    <div class="sc-card__threats">${threatRows}</div>`;

  container.appendChild(card);
}

// ─── Mock Fallback (non-Electron preview) ─────────────────────────────────────

function setMockPassedState(finalStatus, btnProceed) {
  ["hdmi", "meeting", "screen", "wireless", "ai"].forEach((id) =>
    updateCard(id, PASS, "Check passed (preview mode).")
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
    finalStatus.textContent = tr(
      "preflightResults.diagnosticsFailedRetry",
      `Diagnostics failed: ${message}. Please click Rescan to try again.`,
      { message }
    );
    return;
  }

  _scanRetryCount += 1;
  const attempt = tr(
    "preflightResults.attempt",
    `attempt ${_scanRetryCount}/${MAX_SCAN_RETRIES}`,
    { current: _scanRetryCount, max: MAX_SCAN_RETRIES }
  );
  let seconds = 5;

  const renderCountdown = () =>
    tr(
      "preflightResults.diagnosticsFailedCountdown",
      `Diagnostics failed: ${message} — retrying in ${seconds}s… (${attempt})`,
      { message, seconds, attempt }
    );

  finalStatus.className = "sc-status sc-status--warn";
  finalStatus.textContent = renderCountdown();

  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      _isAutoRescan = true; // preserve the retry cap across this programmatic rescan
      btnRescan.click();
    } else {
      finalStatus.textContent = renderCountdown();
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

