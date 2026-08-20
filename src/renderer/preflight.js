/**
 * Preflight security check UI controller.
 * Communicates with the main process via window.electronAPI (contextBridge).
 * App lists and display names are sourced from shared/appList.js.
 */

"use strict";

// Renderer is sandboxed (no require()), so this mirrors shared/appList.js by
// hand. Swap for `require('../shared/appList')` if a bundler gets added.

// Only the display-name map lives here — categorizing a process now happens in
// src/detector/preflightVerdict.js (main), since that feeds `canProceed` and
// the renderer must never be the one deciding the machine is clean.
let APP_DISPLAY_NAMES = {};

function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
}

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
  // Question mark, not a warning triangle: "unverified" isn't the candidate's
  // fault, and a triangle reads as an accusation.
  unknown:
    '<svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
};

// ─── Verdict contract
// Card state comes from main as { id, status, reasonKey, reasonParams,
// blockedApps, threats }. `unverified` blocks Proceed exactly like `fail`.
// `fail` has no constant — it's the fallthrough branch in both card renderers,
// so an unrecognised status blocks Proceed too. Fail-closed by construction.
const PASS = "pass";
const UNVERIFIED = "unverified";

/** English fallbacks for verdict reason keys, used only in the non-Electron preview. */
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
  "preflightResults.agentClear":
    "No AI tools, network anomalies, or automation frameworks detected.",
  "preflightResults.agentFailedStart":
    "Security agent failed to start — it is required to continue. Click Re-scan to retry.",
  "preflightResults.agentUnverified":
    "Deep scan did not complete — this device could not be verified. Click Re-scan.",
  "preflightResults.agentDegraded":
    "Deep scan finished with errors — this device could not be fully verified. Click Re-scan.",
  "preflightResults.agentThreatsDetected":
    "Behavioral threats detected. Close the applications below and rescan.",
};

/** Renders a verdict's reason through i18n, falling back to English in preview. */
function verdictText(v) {
  return tr(v.reasonKey, REASON_FALLBACK[v.reasonKey] || v.reasonKey, v.reasonParams);
}

// True once preflight has fully passed — gates the live pre-proceed watcher.
let _proceedReady = false;

// Robustness guards (see runScans / showScanError / scheduleAutoRescan):
//   _scanRetryCount  — consecutive failed scans auto-retried (F2, capped)
//   _autoRescanCount — consecutive kill→rescan cycles auto-triggered (F3, capped)
//   _isAutoRescan    — set right before a PROGRAMMATIC rescan so a manual click
//                      resets the caps while an auto one preserves them
// Renderer-side abort. MIRRORS PREFLIGHT_RENDERER_TIMEOUT_MS in
// src/shared/constants.js (preload can't require local modules, so it's
// duplicated, not imported); test/preflightBudget.test.js checks they match.
// Must stay above main's PREFLIGHT_GLOBAL_DEADLINE_MS — a cold agent spawn used
// to blow past the old 20000ms budget and trigger a retry storm.
const SCAN_TIMEOUT_MS = 29000;
const MAX_SCAN_RETRIES = 3;
const MAX_AUTO_RESCANS = 3;
let _scanRetryCount = 0;
let _autoRescanCount = 0;
let _isAutoRescan = false;
/** Incremented per scan; progress events from older generations are ignored. */
let _scanGeneration = 0;

// Whether the candidate can satisfy an elevation prompt. Resolved once at page
// load, defaults to FALSE — a standard user or an older bridge without the
// probe just never gets offered it.
let _canElevate = false;
/** Process names already retried with elevation — the offer is strictly one-shot. */
const _elevationTried = new Set();

// Populated as scans run, exported on demand by the Copy-diagnostics control
// (shown once the retry cap is hit) so "it didn't work" reports come with context.
let _appVersion = null;
let _lastScanId = null;
let _lastTimings = null; // per-probe { durationMs, deadlineMs, outcome }
let _lastVerdicts = []; // [{ id, status, reasonKey }]
let _lastCanProceed = null;
let _lastScanError = null;

const PROCEED_ENABLED_CLASS = "sc-btn-proceed sc-btn-proceed--enabled";
const PROCEED_DISABLED_CLASS = "sc-btn-proceed sc-btn-proceed--disabled";
const PROCEED_ARROW =
  '<svg class="sc-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"></path></svg>';

const STATIC_CARD_IDS = ["hdmi", "meeting", "screen", "wireless", "ai"];

// ─── Render state ─────────────────────────────────────────────────────────────
// Every string this page paints through tr() is derived from the state below,
// so renderI18n() can repaint the page in a new locale from what is already
// known. Nothing here is a source of truth for the Proceed gate — that stays
// `results.canProceed` from main, recorded separately in _lastVerdicts.

/** Scanning copy per static card — the markup no longer carries data-i18n for it. */
const CARD_SCANNING_COPY = {
  hdmi: {
    key: "preflight.hdmiScanning",
    fallback: "Scanning for external display connections...",
  },
  meeting: {
    key: "preflight.meetingScanning",
    fallback: "Scanning for active communication software...",
  },
  screen: {
    key: "preflight.screenScanning",
    fallback: "Scanning for recording or streaming applications...",
  },
  wireless: {
    key: "preflight.wirelessScanning",
    fallback: "Scanning for wireless casting or browser activity...",
  },
  ai: { key: "preflight.aiScanning", fallback: "Scanning for interview copilots and cheating tools..." },
};

/** {key, fallback, params, className} for #final-status. A null key means the fallback is literal. */
let _statusState = {
  key: "preflight.runningDiagnostics",
  fallback: "Running security diagnostics...",
  params: null,
  className: "sc-status",
};

/** id -> {phase:"scanning"} | {status, reasonKey, reasonParams, blockedApps} | {status, text}. */
const _cardState = {};
STATIC_CARD_IDS.forEach((id) => {
  _cardState[id] = { phase: "scanning" };
});

/** null (card absent) | {phase} | {verdict}. */
let _agentState = null;
let _proceedLoading = false;
let _diagnosticsNote = null;

// Keyed by element so a rebuilt card drops its rows' state along with the rows,
// exactly as before — a fresh row is a fresh (idle) button.
const _killRowState = new WeakMap();
const _killAllState = new WeakMap();

/**
 * Repaints every tr()-derived string on the page from the state above.
 * PURELY COSMETIC: no IPC, no scan, no verdict, and no change to
 * btn-proceed.disabled — the gate is owned by processResults() alone.
 */
function renderI18n() {
  paintStatus();
  // rebuildActions=false: kill rows are relabelled in place below, so a locale
  // switch can't discard an in-flight kill or detach the button it will paint.
  STATIC_CARD_IDS.forEach((id) => renderStaticCard(id, false));
  paintAgentCard();
  repaintKillRows();
  renderProceedButton();
  renderDiagnosticsControl();
  renderUpdateCard();
}

function setStatus(key, fallback, params, className) {
  _statusState = { key, fallback, params: params || null, className };
  paintStatus();
}

function paintStatus() {
  const el = document.getElementById("final-status");
  if (!el || !_statusState) {
    return;
  }
  const params =
    typeof _statusState.params === "function" ? _statusState.params() : _statusState.params;
  el.textContent = _statusState.key
    ? tr(_statusState.key, _statusState.fallback, params)
    : _statusState.fallback;
  el.className = _statusState.className;
}

/** Text only — the enabled/disabled state and class are set by the gate paths. */
function renderProceedButton() {
  const btn = document.getElementById("btn-proceed");
  if (!btn) {
    return;
  }
  btn.innerHTML = _proceedLoading
    ? `${ICONS.loading} ${tr("preflightResults.loading", "Loading...")}`
    : `<span>${tr("common.continue", "Continue")}</span>${PROCEED_ARROW}`;
}

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
 * Schedules a programmatic rescan after a kill.
 *
 * Prefers evidence over blindly retrying: if the kill layer told us an app
 * `respawned` or is `accessDenied`, rescanning won't help, so we name the
 * culprits and stop instead of burning retries into a generic message.
 * Falls back to the MAX_AUTO_RESCANS counter when there's no outcome detail
 * (older kill backend, or a reported success where the app came back anyway).
 *
 * @param {{respawned?: string[], accessDenied?: string[]}} [evidence]
 *        DISPLAY names (not raw process names) — this text goes to textContent.
 */
function scheduleAutoRescan(evidence) {
  const respawned = evidence?.respawned || [];
  const accessDenied = evidence?.accessDenied || [];

  const halt = (key, fallback, names) =>
    setStatus(key, fallback, { names: names.join(", ") }, "sc-status sc-status--fail");

  if (respawned.length > 0) {
    halt(
      "preflightResults.appsRespawnedStop",
      `These apps restarted themselves: ${respawned.join(", ")}. Turn off their auto-start or sign out of their desktop apps, then click Rescan.`,
      respawned
    );
    return;
  }

  if (accessDenied.length > 0) {
    halt(
      "preflightResults.appsNeedAdminStop",
      `These apps need administrator rights to close: ${accessDenied.join(", ")}. Close them manually, then click Rescan.`,
      accessDenied
    );
    return;
  }

  if (_autoRescanCount >= MAX_AUTO_RESCANS) {
    setStatus(
      "preflightResults.appsReopening",
      "Some apps keep reopening. Close them manually, then click Rescan.",
      null,
      "sc-status sc-status--fail"
    );
    return;
  }
  _autoRescanCount += 1;
  setTimeout(() => {
    _isAutoRescan = true;
    document.getElementById("btn-rescan")?.click();
  }, 2000);
}

document.addEventListener("DOMContentLoaded", async () => {
  // Synchronously, before any await — the initial pre-reveal pass only reaches
  // renderers that are already registered when the bundle lands.
  window.i18n?.registerRenderer?.(renderI18n);

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  const btnRescan = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");

  if (window.electronAPI) {
    try {
      const appList = await window.electronAPI.getAppList();
      APP_DISPLAY_NAMES = appList.displayNames;
    } catch (e) {
      console.error("Failed to load app list", e);
    }
  }

  if (window.electronAPI?.getAppVersion) {
    window.electronAPI
      .getAppVersion()
      .then((v) => {
        _appVersion = v || null;
        const el = document.getElementById("app-version");
        if (el && v) {
          el.textContent = `v${v}`;
        }
      })
      .catch(() => {});
  }

  window.electronAPI
    ?.canElevate?.()
    .then((ok) => {
      _canElevate = ok === true;
    })
    .catch(() => {
      _canElevate = false;
    });

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
    window.electronAPI
      .getUpdateState?.()
      .then((s) => {
        if (!s) {
          return;
        }
        if (s.downloaded) {
          setUpdateCard({ kind: "downloaded", version: s.version });
        } else if (s.state === "downloading") {
          setUpdateCard({ kind: "downloading", percent: s.percent, version: s.version });
        } else if (s.state === "available") {
          setUpdateCard({
            kind: "available",
            version: s.version,
            sizeBytes: s.sizeBytes,
            releaseNotes: s.releaseNotes,
          });
        }
      })
      .catch(() => {});
  }

  // ── Live blocked-app gating of the Proceed button
  // Main pushes {clean, apps} every 2s while the user sits on the success
  // screen, so launching Zoom/OBS after passing but before clicking Proceed
  // still disables it.
  window.electronAPI?.onPreProceedStatus?.(({ clean, apps }) => {
    if (!_proceedReady) {
      return;
    } // only gate once preflight has passed
    applyLiveProceedStatus(clean, apps || [], btnProceed);
  });

  async function runScans() {
    // Manual rescan = fresh start, clear the caps. Programmatic rescan
    // (auto-retry or post-kill) preserves them so the caps actually bound the loop.
    if (!_isAutoRescan) {
      _scanRetryCount = 0;
      _autoRescanCount = 0;
    }
    _isAutoRescan = false;

    setLoadingState(btnProceed, btnRescan);

    if (!window.electronAPI) {
      // Non-Electron preview fallback
      setTimeout(() => setMockPassedState(btnProceed), 1000);
      return;
    }

    // A renderer-side timeout abandons its invoke but can't cancel main's work,
    // so an abandoned scan keeps streaming progress events. This generation
    // guard stops them from repainting the NEW scan's cards with stale results.
    const myGeneration = ++_scanGeneration;

    // Subscribe before invoking so each card updates as its own check lands,
    // rather than all at once at the end.
    window.electronAPI.onPreflightProgress((verdict) => {
      if (myGeneration !== _scanGeneration) {
        return;
      } // superseded — drop it
      applyVerdict(verdict);
    });

    try {
      // Bounds a hung native check so the page can't get stuck on "Scanning"
      // forever. Must stay larger than main's PREFLIGHT_GLOBAL_DEADLINE_MS so
      // main always decides when a scan is over (see src/shared/constants.js).
      const results = await withTimeout(
        window.electronAPI.runPreflight(),
        SCAN_TIMEOUT_MS,
        "Security scan timed out"
      );
      if (myGeneration !== _scanGeneration) {
        return;
      } // a newer scan owns the UI
      // Cards are already painted from the streaming events; this re-applies
      // them (idempotent) and sets the final button state.
      processResults(results, btnProceed, btnRescan);
      _scanRetryCount = 0; // a completed scan (pass or fail) breaks the retry chain
    } catch (err) {
      if (myGeneration !== _scanGeneration) {
        return;
      }
      console.error("[preflight] scan error:", err);
      showScanError(btnRescan, err?.message || "Unknown error");
    } finally {
      // Always clean up the listener to prevent leaks on rescan
      window.electronAPI.removePreflightProgressListener?.();
    }
  }

  btnRescan.addEventListener("click", runScans);

  const proceedBtnHTML = btnProceed.innerHTML; // capture original for restore
  btnProceed.addEventListener("click", () => {
    if (btnProceed.disabled) {
      return;
    }
    // Fail loud if the bridge method is missing — never spin forever silently
    // (synced with the other nav buttons hardened in renderer-production-hardening).
    if (typeof window.electronAPI?.loadPermissionsPage !== "function") {
      setStatus(
        "preflightResults.restartApp",
        "Unable to continue — please restart the app.",
        null,
        "sc-status sc-status--fail"
      );
      return;
    }
    btnProceed.disabled = true;
    btnProceed.className = "sc-btn-proceed sc-btn-proceed--loading";
    _proceedLoading = true;
    renderProceedButton();
    window.electronAPI.loadPermissionsPage();
    // Watchdog: successful navigation tears down this page (timer dies with it).
    // If it fires, navigation never happened — restore the button for a retry.
    window.armButtonRestore(btnProceed, proceedBtnHTML, {
      onRestore: () => {
        btnProceed.className = PROCEED_ENABLED_CLASS;
        // Re-render rather than trust the captured HTML: it was captured in
        // whatever locale was active at load.
        _proceedLoading = false;
        renderProceedButton();
        setStatus(
          "preflightResults.tooLong",
          "That took too long. Please try again.",
          null,
          "sc-status sc-status--fail"
        );
      },
    });
  });

  runScans();
});

function setLoadingState(btnProceed, btnRescan) {
  // A scan is starting — the previous pass no longer authorises anything.
  // Otherwise a pre-proceed push with clean:true, arriving mid-rescan, could
  // re-enable Proceed off a process-only poll before the new cards resolve.
  // Main also pauses that monitor during a scan; this is the second guard.
  _proceedReady = false;
  _lastVerdicts = []; // rebuilt from this scan's streamed verdicts

  btnProceed.disabled = true;
  btnProceed.className = "sc-btn-proceed sc-btn-proceed--loading";
  _proceedLoading = false;
  renderProceedButton();
  btnRescan.disabled = true;
  setStatus(
    "preflight.runningDiagnostics",
    "Running security diagnostics...",
    null,
    "sc-status"
  );

  STATIC_CARD_IDS.forEach((id) => setCardState(id, { phase: "scanning" }));

  // Show the agent card in a pending/scanning state (like the static cards)
  // until its result arrives. renderAgentCard() replaces it with pass/fail.
  renderAgentPending();
}

// In-progress copy for the agent card, keyed by phase. "starting" covers the
// cold spawn — the agent binary unpacking and booting — which is the only wait
// long enough that a bare "Scanning" reads as a hang. Neither state is a
// verdict; both are replaced by renderAgentCard() when the real one lands.
const AGENT_PHASE_COPY = {
  starting: {
    descKey: "preflightResults.agentStarting",
    descFallback: "Starting the security agent…",
    badgeKey: "preflightResults.starting",
    badgeFallback: "Starting",
  },
  scanning: {
    descKey: "preflightResults.runningDeepScan",
    descFallback: "Running deep behavioral scan…",
    badgeKey: "preflightResults.scanning",
    badgeFallback: "Scanning",
  },
};

/**
 * Renders the Deep Scan Agent card in an in-progress state, matching the static
 * cards. Without this the agent card was absent during the scan and popped in
 * already resolved; now it shows its progress first, then pass/fail.
 *
 * @param {"starting"|"scanning"} [phase]
 */
function renderAgentPending(phase = "scanning") {
  _agentState = { phase };
  paintAgentCard();
}

function paintAgentPending(phase) {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".sc-cards");
  if (!container) {
    return;
  }

  const copy = AGENT_PHASE_COPY[phase] || AGENT_PHASE_COPY.scanning;
  const card = document.createElement("div");
  card.id = "card-agent";
  card.className = "sc-card";
  card.innerHTML = `
    <div class="sc-card__row">
      <div class="sc-card__row-left">
        <div class="sc-card__icon">${ICONS.loading}</div>
        <div class="sc-card__body">
          <h3 class="sc-card__title">${tr("preflightResults.agentTitle", "Deep Scan Agent")}</h3>
          <p class="sc-card__desc">${tr(copy.descKey, copy.descFallback)}</p>
        </div>
      </div>
      <div class="sc-badge sc-badge--scanning">${tr(copy.badgeKey, copy.badgeFallback)}</div>
    </div>`;
  container.appendChild(card);
}

/** Redraws the agent card from _agentState. No state — no card, as before the scan. */
function paintAgentCard() {
  if (!_agentState) {
    return;
  }
  if (_agentState.phase) {
    paintAgentPending(_agentState.phase);
  } else {
    paintAgentVerdict(_agentState.verdict);
  }
}

/**
 * Renders one verdict onto its card. Called from both the streaming progress
 * listener and processResults() — idempotent and keyed by card id, so a
 * re-emit (e.g. a physical-monitor cross-check upgrading the HDMI verdict)
 * just replaces the earlier render.
 *
 * @param {{id: string, status: string, reasonKey: string, reasonParams?: object,
 *          blockedApps?: string[], threats?: object[]}} v
 */
function applyVerdict(v) {
  if (!v || !v.id) {
    return;
  }

  // Progress-only event (no status): repaints the in-progress card and returns
  // WITHOUT recording a verdict. Nothing downstream — _lastVerdicts, the
  // Proceed gate, the diagnostics blob — may ever see a phase as a result, so
  // an agent that never finishes booting still falls through to the scan's
  // fail-closed timeout rather than sitting on a friendly "Starting" forever.
  if (v.phase) {
    if (v.id === "agent") {
      renderAgentPending(v.phase);
    }
    return;
  }

  // Record for diagnostics — if the scan later times out, these streamed
  // verdicts are the only per-check state we have to show the candidate reported.
  if (v.scanId) {
    _lastScanId = v.scanId;
  }
  const at = _lastVerdicts.findIndex((x) => x.id === v.id);
  const row = { id: v.id, status: v.status, reasonKey: v.reasonKey };
  if (at >= 0) {
    _lastVerdicts[at] = row;
  } else {
    _lastVerdicts.push(row);
  }

  if (v.id === "agent") {
    renderAgentCard(v);
    return;
  }
  setCardState(v.id, {
    status: v.status,
    reasonKey: v.reasonKey,
    reasonParams: v.reasonParams,
    blockedApps: v.blockedApps || [],
  });
}

/**
 * Called once the scan completes. Re-applies every verdict (idempotent with the
 * streamed ones) and sets the final button + status.
 *
 * Proceed is gated on `results.canProceed`, computed in main — the renderer
 * never derives it, since main re-verifies the same value on click.
 */
function processResults(results, btnProceed, btnRescan) {
  const verdicts = Array.isArray(results?.verdicts) ? results.verdicts : [];
  verdicts.forEach(applyVerdict);

  // Diagnostics capture — a scan that COMPLETED supersedes any earlier failure.
  _lastScanId = results?.scanId ?? null;
  _lastTimings = results?.timings ?? null;
  _lastCanProceed = results?.canProceed === true;
  _lastVerdicts = verdicts.map((v) => ({ id: v.id, status: v.status, reasonKey: v.reasonKey }));
  _lastScanError = null;
  removeDiagnosticsControl();

  // Fail-CLOSED: a malformed or empty response never opens the gate.
  const allPassed = results?.canProceed === true && verdicts.length > 0;
  const anyUnverified = verdicts.some((v) => v.status === UNVERIFIED);

  btnRescan.disabled = false;
  // Gate the live pre-proceed watcher: only react to it once preflight passed.
  _proceedReady = allPassed;

  if (allPassed) {
    _autoRescanCount = 0; // the kill→rescan loop resolved — re-arm auto-rescan
    setStatus(
      "preflightResults.allPassed",
      "All security checks passed. You are ready to start.",
      null,
      "sc-status sc-status--pass"
    );
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    // Distinguish "you have something to close" from "we could not check".
    // Only the first is actionable by the candidate; telling someone to
    // "resolve the security alerts" when a probe failed sends them hunting for
    // a problem that isn't theirs.
    if (anyUnverified) {
      setStatus(
        "preflightResults.someUnverified",
        "Some checks could not be verified. Click Re-scan to try again.",
        null,
        "sc-status sc-status--fail"
      );
    } else {
      setStatus(
        "preflightResults.resolveAlerts",
        "Please resolve the security alerts above to proceed.",
        null,
        "sc-status sc-status--fail"
      );
    }
    btnProceed.disabled = true;
    btnProceed.className = PROCEED_DISABLED_CLASS;
  }
}

/**
 * Live gating of the Proceed button from the pre-proceed watcher: if a blocked
 * app is launched after preflight passes but before the user clicks Proceed,
 * disable Proceed again; re-enable when the screen is clean.
 */
function applyLiveProceedStatus(clean, apps, btnProceed) {
  if (clean) {
    setStatus(
      "preflightResults.allPassed",
      "All security checks passed. You are ready to start.",
      null,
      "sc-status sc-status--pass"
    );
    btnProceed.disabled = false;
    btnProceed.className = PROCEED_ENABLED_CLASS;
  } else {
    const names = apps.map((p) => getDisplayName(p)).join(", ");
    setStatus(
      "preflightResults.blockedAppLaunched",
      `A blocked app was launched: ${names}. Close it to proceed.`,
      { names },
      "sc-status sc-status--fail"
    );
    btnProceed.disabled = true;
    btnProceed.className = PROCEED_DISABLED_CLASS;
  }
}

/** Records a static card's state and repaints it (rebuilding its kill rows). */
function setCardState(id, state) {
  _cardState[id] = state;
  renderStaticCard(id, true);
}

/** The card's description text for its current state. */
function cardDescText(id, state) {
  if (state.phase) {
    const copy = CARD_SCANNING_COPY[id];
    return copy ? tr(copy.key, copy.fallback) : "";
  }
  // Preview-mode literal (no verdict from main), otherwise the verdict reason.
  return typeof state.text === "string" ? state.text : verdictText(state);
}

/**
 * Paints one static card in one of four states.
 *
 * `unverified` is visually distinct from `fail` on purpose: it blocks Proceed
 * just as hard, but it means "we could not establish this", not "you did
 * something wrong". It also carries no kill buttons — there is nothing for the
 * candidate to close, the check simply did not complete.
 *
 * @param {string} id
 * @param {boolean} rebuildActions Rebuild the kill rows from scratch. False for
 *   a locale repaint, which must leave live rows (and any in-flight kill they
 *   are waiting on) attached and only relabel them.
 */
function renderStaticCard(id, rebuildActions) {
  const state = _cardState[id];
  if (!state) {
    return;
  }
  const cardEl = document.getElementById(`card-${id}`);
  const iconEl = document.getElementById(`icon-${id}`);
  const descEl = document.getElementById(`desc-${id}`);
  const actionsEl = document.getElementById(`actions-${id}`);
  const badgeEl = document.getElementById(`badge-${id}`);
  if (!cardEl || !iconEl || !descEl) {
    return;
  }

  if (actionsEl && rebuildActions) {
    actionsEl.innerHTML = "";
  }
  descEl.textContent = cardDescText(id, state);

  if (state.phase) {
    cardEl.className = "sc-card";
    iconEl.innerHTML = ICONS.loading;
    iconEl.className = "sc-card__icon";
    descEl.className = "sc-card__desc";
    if (badgeEl) {
      badgeEl.className = "sc-badge sc-badge--scanning";
      badgeEl.textContent = tr("preflightResults.scanning", "Scanning");
    }
    return;
  }

  const status = state.status;

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
  const blockedApps = state.blockedApps || [];
  if (rebuildActions && actionsEl && blockedApps.length > 0) {
    renderKillButtons(actionsEl, blockedApps);
  }
}

// Small inline icons for the kill row/button states. Defined once so the
// per-outcome branches below stay readable.
const KILL_ICON = {
  x: '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>',
  close:
    '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>',
  check:
    '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
  spin: '<svg class="sc-icon-xs spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
  // Same glyph as the spinner but static — "this came back on its own".
  reopen:
    '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
  lock: '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>',
  clock:
    '<svg class="sc-icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
};

function renderKillButtons(container, blockedApps) {
  blockedApps.forEach((appName) => {
    const row = document.createElement("div");
    row.className = "sc-kill-row";
    // Lets handleKillAll map a per-app KillResult back onto its own row.
    // Read via dataset comparison, never interpolated into a selector — the
    // process name is attacker-influenceable.
    row.dataset.process = appName;

    // appName is a live OS process name — attacker-influenceable (a candidate
    // can rename an executable to an HTML payload). Escape before innerHTML.
    const safeDisplay = window.escHtml(getDisplayName(appName));
    const safeProcess = window.escHtml(appName);

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
    btn.addEventListener("click", () => handleKillApp(btn, appName, row));

    row.appendChild(btn);
    container.appendChild(row);
    setKillRowState(row, btn, appName, { kind: "idle" });
  });

  if (blockedApps.length > 1) {
    const closeAllBtn = document.createElement("button");
    closeAllBtn.addEventListener("click", () => handleKillAll(closeAllBtn, blockedApps));
    container.appendChild(closeAllBtn);
    setKillAllState(closeAllBtn, { kind: "idle" });
  }
}

// ─── Kill row / Close-All painting ────────────────────────────────────────────
// State lives beside the element so a locale repaint can redraw a row's label
// without re-running the kill, and so a card rebuild drops it with the row.

/** Records a row's state and paints it. Returns the coarse category, if any. */
function setKillRowState(row, btn, processName, state) {
  _killRowState.set(row, state);
  return paintKillRow(row, btn, processName, state);
}

function setKillAllState(btn, state) {
  _killAllState.set(btn, state);
  paintKillAllBtn(btn, state);
}

/** Relabels every rendered kill control in place from its retained state. */
function repaintKillRows() {
  document.querySelectorAll(".sc-kill-row").forEach((row) => {
    const btn = row.querySelector(".sc-kill-btn");
    const state = _killRowState.get(row);
    if (btn && state) {
      paintKillRow(row, btn, row.dataset.process, state);
    }
  });
  document.querySelectorAll(".sc-kill-all-btn").forEach((btn) => {
    const state = _killAllState.get(btn);
    if (state) {
      paintKillAllBtn(btn, state);
    }
  });
}

const REFRESH_PATH =
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>';
const KILL_ALL_SPINNER = `<svg class="sc-icon-sm spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24">${REFRESH_PATH}</svg>`;
const KILL_ALL_REFRESH = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">${REFRESH_PATH}</svg>`;
const CHECK_PATH =
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>';
const X_PATH =
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>';

function paintKillAllBtn(btn, state) {
  if (state.kind === "idle") {
    btn.disabled = false;
    btn.className = "sc-kill-all-btn";
    btn.innerHTML = `${KILL_ALL_REFRESH} ${tr("preflightResults.closeAllRescan", "Close All & Re-scan")}`;
    return;
  }
  if (state.kind === "killing") {
    btn.disabled = true;
    btn.className = "sc-kill-all-btn sc-kill-all-btn--killing";
    btn.innerHTML = `${KILL_ALL_SPINNER} ${tr("preflightResults.closingAll", "Closing all apps...")}`;
    return;
  }
  // Summary — reached only after the killing state disabled the button.
  btn.disabled = true;
  btn.className = `sc-kill-all-btn sc-kill-all-btn--${state.variant}`;
  btn.innerHTML = `<svg class="sc-icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24">${state.icon}</svg> ${tr(state.key, state.fallback, state.params)}`;
}

// ─── Kill Result Contract ─────────────────────────────────────────────────────
//
// killProcess(name) / killAllProcesses(names) resolve to KillResult /
// KillResult[]:
//   { processName, success, outcome, error?, companionsKilled?, pidsKilled? }
// where outcome ∈ closed | already-gone | access-denied | respawned |
//                still-running | not-blocked | own-process | spawn-error |
//                unsupported
//
// `error` is a technical string for diagnostics and is deliberately never read
// here, so an OS error message can't reach the candidate's screen.
//
// `outcome` is treated as OPTIONAL — an older backend returning only
// `{ success }` still works, degrading to binary messaging instead of "undefined".

const SUCCESS_KILL_OUTCOMES = new Set(["closed", "already-gone"]);
const KNOWN_KILL_OUTCOMES = new Set([
  "closed",
  "already-gone",
  "access-denied",
  "respawned",
  "still-running",
  "not-blocked",
  "own-process",
  "spawn-error",
  "unsupported",
]);

/**
 * Coerces whatever the kill IPC returned into a shape this file can trust.
 *
 * A recognised `outcome` is AUTHORITATIVE for success — `success` is derived
 * from it, not believed, so a backend reporting success:true alongside
 * `respawned` can't tell the candidate the app is closed.
 *
 * @param {any} raw
 * @param {string} processName fallback identity if the payload omits it
 * @returns {{processName: string, success: boolean, outcome: string|null}}
 */
function normalizeKillResult(raw, processName) {
  const outcome =
    typeof raw?.outcome === "string" && KNOWN_KILL_OUTCOMES.has(raw.outcome) ? raw.outcome : null;
  return {
    processName: typeof raw?.processName === "string" ? raw.processName : processName,
    success: outcome ? SUCCESS_KILL_OUTCOMES.has(outcome) : raw?.success === true,
    outcome,
  };
}

/**
 * Writes (or replaces) the explanatory line under a kill row.
 * Uses textContent, so the display name is passed through UNESCAPED here —
 * escaping is only needed on the innerHTML button paths.
 */
function setKillHint(row, text, tone) {
  let hint = row.nextElementSibling;
  if (!hint || !hint.classList?.contains("sc-kill-hint")) {
    hint = document.createElement("p");
    hint.setAttribute("role", "status");
    row.insertAdjacentElement("afterend", hint);
  }
  hint.className = `sc-kill-hint sc-kill-hint--${tone}`;
  hint.textContent = text;
}

function clearKillHint(row) {
  const hint = row.nextElementSibling;
  if (hint?.classList?.contains("sc-kill-hint")) {
    hint.remove();
  }
}

/**
 * Paints one kill row from its KillResult and returns a coarse category the
 * callers aggregate on: "closed" | "respawned" | "access-denied" |
 * "still-running" | "failed". Each non-success outcome gets its own copy —
 * "needs admin", "restarted itself", and "still shutting down" call for
 * different actions from the candidate.
 */
function applyKillOutcome(row, btn, processName, norm) {
  return setKillRowState(row, btn, processName, { kind: "outcome", norm });
}

/**
 * Draws one kill row for its retained state. Deterministic and free of side
 * effects beyond the row itself — the auto-rescan decisions live in the kill
 * handlers, which act on the category this returns.
 */
function paintKillRow(row, btn, processName, state) {
  const display = getDisplayName(processName);
  const safeName = window.escHtml(display);

  if (state.kind === "idle") {
    clearKillHint(row);
    row.classList.remove("sc-kill-row--closed", "sc-kill-row--respawned", "sc-kill-row--blocked");
    btn.disabled = false;
    btn.className = "sc-kill-btn";
    btn.innerHTML = `${KILL_ICON.close} ${tr("preflightResults.closeApp", `Close ${safeName}`, { name: safeName })}`;
    return null;
  }

  if (state.kind === "closing") {
    btn.disabled = true;
    btn.className = "sc-kill-btn sc-kill-btn--killing";
    btn.innerHTML = `${KILL_ICON.spin} ${
      state.elevated
        ? tr("preflightResults.killElevateWaiting", "Waiting for permission...")
        : tr("preflightResults.closing", "Closing...")
    }`;
    return null;
  }

  if (state.kind === "error") {
    clearKillHint(row);
    btn.className = "sc-kill-btn sc-kill-btn--failed";
    btn.innerHTML = `${KILL_ICON.x} ${tr("preflightResults.closeErrorManual", `Error — close ${safeName} manually`, { name: safeName })}`;
    btn.disabled = false;
    return null;
  }

  const norm = state.norm;

  row.classList.remove("sc-kill-row--closed", "sc-kill-row--respawned", "sc-kill-row--blocked");

  if (norm.success) {
    clearKillHint(row);
    btn.disabled = true;
    btn.className = "sc-kill-btn sc-kill-btn--killed";
    btn.innerHTML = `${KILL_ICON.check} ${
      norm.outcome === "already-gone"
        ? tr("preflightResults.alreadyClosed", "Already closed")
        : tr("preflightResults.closed", "Closed")
    }`;
    row.classList.add("sc-kill-row--closed");
    row.querySelector(".sc-kill-ping")?.remove();
    const dot = row.querySelector(".sc-kill-dot");
    if (dot) {
      dot.className = "sc-kill-dot sc-kill-dot--closed";
    }
    return "closed";
  }

  // THE headline case: clicking Close again just restarts the loop, so the
  // button stops offering it and the hint points at the actual fix.
  if (norm.outcome === "respawned") {
    row.classList.add("sc-kill-row--respawned");
    btn.disabled = true;
    btn.className = "sc-kill-btn sc-kill-btn--respawned";
    btn.innerHTML = `${KILL_ICON.reopen} ${tr("preflightResults.killRespawnedBtn", "Reopened itself")}`;
    setKillHint(
      row,
      tr(
        "preflightResults.killRespawnedHint",
        `${display} restarted itself after closing. Turn off its auto-start (or sign out of its desktop app), then click Rescan.`,
        { name: display }
      ),
      "respawned"
    );
    return "respawned";
  }

  if (norm.outcome === "access-denied") {
    row.classList.add("sc-kill-row--blocked");

    // Offer an elevated retry only when the candidate can actually complete it,
    // and only once. A standard user would just get a credential prompt they
    // can't satisfy, so they go straight to the manual route instead.
    if (_canElevate && !_elevationTried.has(processName)) {
      btn.disabled = false;
      btn.dataset.mode = "elevate";
      btn.className = "sc-kill-btn sc-kill-btn--elevate";
      btn.innerHTML = `${KILL_ICON.lock} ${tr("preflightResults.killElevateBtn", "Close with admin rights")}`;
      setKillHint(
        row,
        tr(
          "preflightResults.killElevateHint",
          `${display} needs administrator rights. Your system will ask you to confirm before it closes.`,
          { name: display }
        ),
        "blocked"
      );
      return "access-denied";
    }

    btn.disabled = true;
    btn.className = "sc-kill-btn sc-kill-btn--blocked";
    btn.innerHTML = `${KILL_ICON.lock} ${tr("preflightResults.killAdminBtn", "Needs admin rights")}`;
    setKillHint(
      row,
      tr(
        "preflightResults.killAdminHint",
        `${display} needs administrator rights to close. Close it yourself from its own window, then click Rescan.`,
        { name: display }
      ),
      "blocked"
    );
    return "access-denied";
  }

  // Genuinely worth another click in a moment.
  if (norm.outcome === "still-running") {
    btn.disabled = false;
    btn.className = "sc-kill-btn sc-kill-btn--retry";
    btn.innerHTML = `${KILL_ICON.clock} ${tr("preflightResults.killStillClosingBtn", "Still closing — try again")}`;
    setKillHint(
      row,
      tr(
        "preflightResults.killStillClosingHint",
        `${display} is still shutting down. Wait a few seconds, then click Close again.`,
        { name: display }
      ),
      "pending"
    );
    return "still-running";
  }

  // not-blocked / own-process / spawn-error / unsupported / unknown / legacy
  // boolean failure. One safe generic message — the raw `error` never surfaces.
  btn.disabled = false;
  btn.className = "sc-kill-btn sc-kill-btn--failed";
  btn.innerHTML = `${KILL_ICON.x} ${tr("preflightResults.closeFailedManual", `Failed — close ${safeName} manually`, { name: safeName })}`;
  if (norm.outcome) {
    setKillHint(
      row,
      tr(
        "preflightResults.killGenericHint",
        `${display} could not be closed automatically. Close it yourself, then click Rescan.`,
        { name: display }
      ),
      "blocked"
    );
  }
  return "failed";
}

// ─── Kill Handlers ────────────────────────────────────────────────────────────

async function handleKillApp(btn, processName, row) {
  // This click is explicit consent to elevate (the button was relabelled for
  // it) — never an automatic fallback, and never repeated: recorded either way
  // so a failed or declined prompt can't loop back. Read before painting, since
  // the paint owns the button's markup from here on.
  const elevated = btn.dataset.mode === "elevate";
  if (elevated) {
    delete btn.dataset.mode;
    _elevationTried.add(processName);
  }

  setKillRowState(row, btn, processName, { kind: "closing", elevated });

  let raw;
  try {
    raw = elevated
      ? await window.electronAPI.killProcessElevated?.(processName)
      : await window.electronAPI.killProcess(processName);
  } catch {
    setKillRowState(row, btn, processName, { kind: "error" });
    return;
  }

  const category = applyKillOutcome(row, btn, processName, normalizeKillResult(raw, processName));
  const display = getDisplayName(processName);

  if (category === "closed") {
    // F4: derive "all closed" from the live DOM (rows still open across every
    // card) rather than a running counter that drifts on the fail-closed path.
    const stillOpen = document.querySelectorAll(".sc-kill-row:not(.sc-kill-row--closed)").length;
    if (stillOpen === 0) {
      scheduleAutoRescan();
    }
  } else if (category === "respawned") {
    scheduleAutoRescan({ respawned: [display] });
  } else if (category === "access-denied") {
    scheduleAutoRescan({ accessDenied: [display] });
  }
}

/**
 * Mirrors validateProcessName() in src/main/ipcHandlers.js, which strips the
 * name before killing — so a KillResult can come back under the stripped
 * spelling. Used only to pair a result with its row, never to display.
 */
function sanitiseProcessKey(name) {
  return String(name || "").replace(/[^\w.\- ]/g, "");
}

/** Finds the rendered row for a process name without building a CSS selector. */
function findKillRow(container, processName) {
  const rows = container ? container.querySelectorAll(".sc-kill-row") : [];
  for (const row of rows) {
    if (row.dataset.process === processName) {
      return { row, btn: row.querySelector(".sc-kill-btn") };
    }
  }
  return null;
}

async function handleKillAll(btn, processNames) {
  const container = btn.parentElement;
  setKillAllState(btn, { kind: "killing" });

  const setSummary = (variant, icon, key, fallback, params) =>
    setKillAllState(btn, { kind: "summary", variant, icon, key, fallback, params: params || null });

  let results;
  try {
    results = await window.electronAPI.killAllProcesses(processNames);
  } catch {
    setSummary(
      "failed",
      X_PATH,
      "preflightResults.someFailedToClose",
      "Some apps failed to close"
    );
    scheduleAutoRescan();
    return;
  }

  // Older backend (or a bridge that resolves with nothing): no per-app truth is
  // available, so fall back to the previous behaviour rather than inventing one.
  if (!Array.isArray(results)) {
    setSummary(
      "success",
      CHECK_PATH,
      "preflightResults.allClosedRescanning",
      "All apps closed — re-scanning..."
    );
    scheduleAutoRescan();
    return;
  }

  // Per-app truth: reflect each result on its own row. A missing entry is a
  // failure, not a success — fail-closed, like the verdict path.
  //
  // Results come back keyed by the SANITISED name (IPC strips characters
  // outside [\w.- ] before killing), which won't match a renamed executable
  // byte-for-byte. Index both ways; the sanitised index drops ambiguous keys
  // so a collision can never cross-apply an outcome to the wrong row.
  const byName = new Map();
  const bySanitised = new Map();
  const collided = new Set();
  results.forEach((r) => {
    if (!r || typeof r.processName !== "string") {
      return;
    }
    byName.set(r.processName, r);
    const key = sanitiseProcessKey(r.processName);
    if (bySanitised.has(key)) {
      collided.add(key);
    } else {
      bySanitised.set(key, r);
    }
  });
  collided.forEach((key) => bySanitised.delete(key));

  const lookup = (name) => {
    if (byName.has(name)) {
      return byName.get(name);
    }
    return bySanitised.get(sanitiseProcessKey(name));
  };

  const evidence = { respawned: [], accessDenied: [] };
  let closedCount = 0;
  let retryableCount = 0;

  processNames.forEach((name) => {
    const found = findKillRow(container, name);
    if (!found || !found.btn) {
      return;
    }
    const category = applyKillOutcome(
      found.row,
      found.btn,
      name,
      normalizeKillResult(lookup(name), name)
    );
    if (category === "closed") {
      closedCount += 1;
    } else if (category === "respawned") {
      evidence.respawned.push(getDisplayName(name));
    } else if (category === "access-denied") {
      evidence.accessDenied.push(getDisplayName(name));
    } else if (category === "still-running") {
      retryableCount += 1;
    }
  });

  const total = processNames.length;

  if (closedCount === total) {
    setSummary(
      "success",
      CHECK_PATH,
      "preflightResults.allClosedRescanning",
      "All apps closed — re-scanning..."
    );
    scheduleAutoRescan();
    return;
  }

  if (evidence.respawned.length > 0) {
    setSummary(
      "failed",
      X_PATH,
      "preflightResults.killAllReopened",
      "Some apps reopened themselves"
    );
  } else if (closedCount === 0) {
    setSummary(
      "failed",
      X_PATH,
      "preflightResults.someFailedToClose",
      "Some apps failed to close"
    );
  } else {
    setSummary(
      "partial",
      X_PATH,
      "preflightResults.killAllPartial",
      `${closedCount} of ${total} closed — close the rest manually`,
      { closed: closedCount, total }
    );
  }

  if (evidence.respawned.length > 0 || evidence.accessDenied.length > 0) {
    // Naming the culprit beats spending three rescans to reach a generic line.
    scheduleAutoRescan(evidence);
  } else if (closedCount > 0 || retryableCount > 0) {
    // Real progress (or an app mid-shutdown) — a rescan can still resolve this.
    scheduleAutoRescan();
  }
  // Otherwise: nothing closed and nothing pending. The rows now each carry
  // their own manual-close instruction; a rescan would only repaint them.
}

// ─── Agent Card ───────────────────────────────────────────────────────────────

/**
 * Renders the Deep Scan Agent card from its verdict. Three distinct non-pass
 * states matter here: an agent that answers ping but returns no scan must not
 * fall through to a green "Ready" badge on the strength of a scan that never ran.
 *
 * @param {{status: string, reasonKey: string, reasonParams?: object, threats?: object[]}} v
 */
function renderAgentCard(v) {
  _agentState = { verdict: v };
  paintAgentCard();
}

function paintAgentVerdict(v) {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".sc-cards");
  if (!container) {
    return;
  }

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
            <p class="sc-card__desc sc-card__desc--unverified">${window.escHtml(desc)}</p>
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
            <p class="sc-card__desc">${window.escHtml(desc)}</p>
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
            <p class="sc-card__desc sc-card__desc--fail">${window.escHtml(desc)}</p>
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
        <span class="sc-threat-title">${window.escHtml(t.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))}</span>
        <p class="sc-threat-detail">${window.escHtml(t.detail)}</p>
      </div>
      <span class="sc-threat-badge sc-threat-badge--${t.severity === "HIGH" ? "high" : "medium"}">${window.escHtml(t.severity)}</span>
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
          <p class="sc-card__desc sc-card__desc--fail">${window.escHtml(desc)}</p>
        </div>
      </div>
      <div class="sc-badge sc-badge--fail">${tr("preflightResults.actionRequired", "Action Required")}</div>
    </div>
    <div class="sc-card__threats">${threatRows}</div>`;

  container.appendChild(card);
}

// ─── Mock Fallback (non-Electron preview) ─────────────────────────────────────

function setMockPassedState(btnProceed) {
  STATIC_CARD_IDS.forEach((id) =>
    setCardState(id, { status: PASS, text: "Check passed (preview mode)." })
  );
  setStatus(null, "Preview mode — all checks simulated as passed.", null, "sc-status");
  btnProceed.disabled = false;
}

// ─── Error Boundary (IMP-15) ─────────────────────────────────────────────────

/**
 * Displays a structured scan-failure message with an auto-retry countdown.
 * Replaces the silent "Error running diagnostics." grey text.
 * @param {HTMLButtonElement} btnRescan
 * @param {string} message
 */
function showScanError(btnRescan, message) {
  btnRescan.disabled = false;
  _lastScanError = message;

  // F2: stop the auto-retry storm. After MAX_SCAN_RETRIES consecutive failures
  // stop counting down and leave a manual Rescan prompt instead of hammering
  // the backend forever.
  if (_scanRetryCount >= MAX_SCAN_RETRIES) {
    setStatus(
      "preflightResults.diagnosticsFailedRetry",
      `Diagnostics failed: ${message}. Please click Rescan to try again.`,
      { message },
      "sc-status sc-status--fail"
    );
    // The candidate is now genuinely stuck. Give them something to send support
    // instead of a screenshot of a red line — this is the only point in the flow
    // where the export is offered, so it never becomes ambient UI noise.
    showDiagnosticsControl();
    return;
  }

  _scanRetryCount += 1;
  const attemptNo = _scanRetryCount;
  let seconds = 5;

  // A function, not a fixed object: `attempt` is itself translated, so it has
  // to be re-derived when the locale changes mid-countdown.
  const countdownParams = () => ({
    message,
    seconds,
    attempt: tr("preflightResults.attempt", `attempt ${attemptNo}/${MAX_SCAN_RETRIES}`, {
      current: attemptNo,
      max: MAX_SCAN_RETRIES,
    }),
  });

  const paintCountdown = () =>
    setStatus(
      "preflightResults.diagnosticsFailedCountdown",
      `Diagnostics failed: ${message} — retrying in ${seconds}s… (attempt ${attemptNo}/${MAX_SCAN_RETRIES})`,
      countdownParams,
      "sc-status sc-status--warn"
    );

  paintCountdown();

  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      _isAutoRescan = true; // preserve the retry cap across this programmatic rescan
      btnRescan.click();
    } else {
      paintCountdown();
    }
  }, 1000);
}

// ─── Diagnostics Export (Phase E) ────────────────────────────────────────────
// Produces a compact, paste-able text blob naming which probe failed and how
// long it took — the durations distinguish a blown deadline from an instant error.
//
// PRIVACY: assembled from an explicit allow-list of fields only — no tokens,
// file paths, user identity, or process names beyond what's already on screen.
// Audit entries are re-projected field by field, not dumped, so a future audit
// field can't silently start leaking into a support paste.

const MAX_DIAGNOSTIC_AUDIT_ENTRIES = 15;

/** Fixed-width left pad for the plain-text tables in the blob. */
function pad(text, width) {
  const s = String(text ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** One timing row: "process    4001ms  timeout  (deadline 4000ms)". */
function formatTimingRows(timings) {
  const entries = Object.entries(timings || {});
  if (entries.length === 0) {
    return ["  (none recorded)"];
  }
  return entries.map(
    ([key, t]) =>
      `  ${pad(key, 10)}${pad(`${t?.durationMs ?? "?"}ms`, 9)}` +
      `${pad(t?.outcome ?? "?", 9)}(deadline ${t?.deadlineMs ?? "?"}ms)`
  );
}

/**
 * Projects one audit entry onto the small set of fields that are safe to share
 * and actually diagnostic. Anything not named here is dropped.
 * @returns {string|null} a single log line, or null if the entry isn't relevant
 */
function projectAuditEntry(entry) {
  const ts = String(entry?.timestamp || "")
    .replace("T", " ")
    .replace(/\..*$/, "");
  const d = entry?.data || {};

  if (entry?.type === "scan" && d.phase === "preflight") {
    const verdicts = Array.isArray(d.verdicts)
      ? d.verdicts.map((v) => `${v.id}:${v.status}`).join(" ")
      : "";
    const timings = Object.entries(d.timings || {})
      .map(([k, t]) => `${k}=${t?.durationMs}ms/${t?.outcome}`)
      .join(" ");
    return (
      `  ${ts} preflight scan=${d.scanId} ${d.durationMs}ms ` +
      `canProceed=${d.canProceed} [${verdicts}] ${timings}`
    );
  }

  if (entry?.type === "scan") {
    // Live-interview tick. blockedApps are the same names rendered as kill
    // buttons on this page; nothing else from the tick is included.
    const apps = Array.isArray(d.blockedApps) ? d.blockedApps.join(",") : "";
    return (
      `  ${ts} tick display=${d.hdmiStatus} process=${d.processStatus} ` +
      `agentReachable=${d.agentReachable} blockedApps=[${apps}]`
    );
  }

  if (entry?.type === "violation") {
    // Severity/counters only — the `event` string is free text assembled from
    // agent threat details, so it stays out of a blob the candidate pastes.
    return `  ${ts} violation severity=${d.severity} count=${d.count} hardBlock=${d.isHardBlock}`;
  }

  return null;
}

/** Newest preflight audit entry, used to recover the agent version. */
function findAgentVersion(auditEntries) {
  for (let i = auditEntries.length - 1; i >= 0; i -= 1) {
    const v = auditEntries[i]?.data?.agentVersion;
    if (v) {
      return v;
    }
  }
  return null;
}

/**
 * Assembles the diagnostics blob.
 * @returns {Promise<string>}
 */
async function buildDiagnosticsText() {
  let audit = [];
  try {
    audit = (await window.electronAPI?.getAuditLog?.()) || [];
  } catch {
    audit = [];
  }

  const auditLines = audit
    .slice(-MAX_DIAGNOSTIC_AUDIT_ENTRIES)
    .map(projectAuditEntry)
    .filter(Boolean);

  const checkLines =
    _lastVerdicts.length > 0
      ? _lastVerdicts.map((v) => `  ${pad(v.id, 10)}${pad(v.status, 12)}${v.reasonKey || ""}`)
      : ["  (no check completed)"];

  return [
    "LetsHyre preflight diagnostics",
    `generated:     ${new Date().toISOString()}`,
    `appVersion:    ${_appVersion || "unknown"}`,
    `agentVersion:  ${findAgentVersion(audit) || "unknown"}`,
    `platform:      ${navigator.platform || "unknown"}`,
    `locale:        ${window.i18n?.getLocale?.() || document.documentElement.lang || "unknown"}`,
    `scanId:        ${_lastScanId || "none"}`,
    `canProceed:    ${_lastCanProceed === null ? "unknown" : _lastCanProceed}`,
    `consecutiveScanFailures: ${_scanRetryCount}`,
    `lastError:     ${_lastScanError || "none"}`,
    "",
    "checks:",
    ...checkLines,
    "",
    "probe timings:",
    ...formatTimingRows(_lastTimings),
    "",
    `recent audit (${auditLines.length}):`,
    ...(auditLines.length > 0 ? auditLines : ["  (empty)"]),
  ].join("\n");
}

/**
 * Copies text to the clipboard, degrading gracefully. navigator.clipboard needs
 * a secure context and this page loads over file://, so it may not exist —
 * execCommand is the fallback; if both fail the caller shows the text for
 * manual selection instead of doing nothing.
 * @returns {Promise<boolean>}
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Removes the diagnostics control and any fallback textarea. */
function removeDiagnosticsControl() {
  document.getElementById("diagnostics-wrap")?.remove();
  _diagnosticsNote = null;
}

const DIAGNOSTICS_NOTE_COPY = {
  copied: {
    key: "preflightResults.diagnosticsCopied",
    fallback: "Diagnostics copied. Paste them in your message to support.",
  },
  failed: {
    key: "preflightResults.diagnosticsCopyFailed",
    fallback: "Could not copy automatically. Select the text below and copy it.",
  },
};

/** Relabels the diagnostics control if it is on screen. */
function renderDiagnosticsControl() {
  const btn = document.getElementById("btn-diagnostics");
  if (btn) {
    btn.textContent = tr("preflightResults.copyDiagnostics", "Copy diagnostics");
  }
  const copy = DIAGNOSTICS_NOTE_COPY[_diagnosticsNote];
  const note = document.querySelector("#diagnostics-wrap .sc-diagnostics__note");
  if (note && copy) {
    note.textContent = tr(copy.key, copy.fallback);
  }
}

/**
 * Renders the "Copy diagnostics" control under the footer status line.
 * Idempotent — repeated failed scans re-enter showScanError but must not stack
 * up duplicate buttons.
 */
function showDiagnosticsControl() {
  if (document.getElementById("diagnostics-wrap")) {
    return;
  }
  const footer = document.querySelector(".sc-footer");
  if (!footer) {
    return;
  }

  const wrap = document.createElement("div");
  wrap.id = "diagnostics-wrap";
  wrap.className = "sc-diagnostics";

  const btn = document.createElement("button");
  btn.id = "btn-diagnostics";
  btn.type = "button";
  btn.className = "sc-btn-diagnostics";
  btn.textContent = tr("preflightResults.copyDiagnostics", "Copy diagnostics");

  const note = document.createElement("p");
  note.className = "sc-diagnostics__note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    let text = "";
    try {
      text = await buildDiagnosticsText();
    } catch (e) {
      console.error("[preflight] diagnostics build failed:", e);
    }
    const copied = text ? await copyToClipboard(text) : false;
    _diagnosticsNote = copied ? "copied" : "failed";
    renderDiagnosticsControl();
    if (copied) {
      wrap.querySelector("textarea")?.remove();
    } else {
      let ta = wrap.querySelector("textarea");
      if (!ta) {
        ta = document.createElement("textarea");
        ta.className = "sc-diagnostics__text";
        ta.setAttribute("readonly", "");
        ta.rows = 8;
        wrap.appendChild(ta);
      }
      ta.value = text;
      ta.select();
    }
    btn.disabled = false;
  });

  wrap.appendChild(btn);
  wrap.appendChild(note);
  footer.appendChild(wrap);
}

// ─── Auto-Updater Card ────────────────────────────────────────────────────────
// Consent-first, bottom-right floating card. The main process gates download and
// install (never during an interview); the renderer only reflects state and
// relays the user's choice. Update-check failures never render anything.

let _update = { kind: "idle", notesOpen: false };

/** Formats a byte count as a compact human string (e.g. "12.4 MB"). */
function formatBytes(bytes) {
  if (!bytes || bytes < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
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

  if (!s || s.kind === "idle") {
    existing?.remove();
    return;
  }

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
  const icon =
    {
      available:
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
      downloading:
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
      downloaded:
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>',
    }[s.kind] || "";

  const head = (title, tone = "") => `
    <div class="update-card__head">
      <span class="update-card__icon ${tone}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg>
      </span>
      <span class="update-card__title">${title}</span>
      ${s.version ? `<span class="update-card__chip">v${window.escHtml(s.version)}</span>` : ""}
    </div>`;

  const notes = s.releaseNotes
    ? `<button class="update-card__notes-toggle" onclick="window.__updateAction('notes')">
         ${s.notesOpen ? tr("updater.hideNotes", "Hide") : tr("updater.whatsNew", "What’s new")}
       </button>
       ${
         s.notesOpen
           ? `<div class="update-card__notes">${window
               .escHtml(typeof s.releaseNotes === "string" ? s.releaseNotes : "")
               .slice(0, 1200)}</div>`
           : ""
       }`
    : "";

  switch (s.kind) {
    case "available": {
      const size = s.sizeBytes ? ` (${formatBytes(s.sizeBytes)})` : "";
      return `
        ${head(tr("updater.available", "Update available"))}
        <p class="update-card__body">${tr("updater.downloadingInBackground", `Downloading in the background${size}…`, { size })}</p>
        ${notes}`;
    }
    case "downloading": {
      const pct = Math.max(0, Math.min(100, s.percent ?? 0));
      const sizeLine =
        s.transferred && s.total ? `${formatBytes(s.transferred)} / ${formatBytes(s.total)}` : "";
      return `
        ${head(tr("updater.downloading", "Downloading update"))}
        <div class="update-card__progress"><div class="update-card__progress-bar" style="width:${pct}%"></div></div>
        <p class="update-card__meta"><span>${pct}%</span><span>${sizeLine}</span></p>`;
    }
    case "downloaded":
      return `
        ${head(tr("updater.ready", "Update ready"), "update-card__icon--ok")}
        <p class="update-card__body">${tr("updater.readyBody", "It installs automatically when you close the app.")}</p>
        <div class="update-card__actions">
          <button class="update-card__btn update-card__btn--primary" onclick="window.__updateAction('install')">${tr("updater.updateNow", "Update now")}</button>
          <button class="update-card__btn update-card__btn--ghost" onclick="window.__updateAction('dismiss')">${tr("updater.dismiss", "Dismiss")}</button>
        </div>
        <p class="update-card__hint">${tr("updater.readyHint", '"Update now" closes the app and installs — reopen from your interview link.')}</p>`;
    default:
      return "";
  }
}
