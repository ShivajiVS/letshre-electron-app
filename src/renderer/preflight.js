/**
 * Security-check (preflight) page controller. Talks to main over
 * window.electronAPI; pure decisions live in preflightModel.js.
 */

"use strict";

const PM = window.PreflightModel;

// Must stay above main's PREFLIGHT_GLOBAL_DEADLINE_MS so main always decides
// when a scan is over. Mirrors PREFLIGHT_RENDERER_TIMEOUT_MS (checked by
// test/preflightBudget.test.js).
const SCAN_TIMEOUT_MS = 29000;
const MAX_SCAN_RETRIES = 3;
const MAX_AUTO_RESCANS = 3;
const RETRY_COUNTDOWN_MS = 5000;
const KILL_RESCAN_DELAY_MS = 2000;
const LIVE_CLEAR_RESCAN_DELAY_MS = 1500;
// Clean pushes needed before a card turns back green, so apps shutting down in stages don't flicker.
const LIVE_CLEAN_TICKS = 2;
const DEFER_RESCAN_MS = 1000;

const STATUS = "sc-status";
const STATUS_PASS = "sc-status sc-status--pass";
const STATUS_FAIL = "sc-status sc-status--fail";
const STATUS_WARN = "sc-status sc-status--warn";

const PREVIEW_CARD_TEXT = "Check passed (preview mode).";
const PREVIEW_STATUS_TEXT = "Preview mode — all checks simulated as passed.";

let APP_DISPLAY_NAMES = {};

function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

/** window.t with an English fallback for preview mode, where no bundle is loaded. */
function tr(key, fallback, params) {
  if (window.t && key) {
    const out = window.t(key, params);
    if (out !== key) {
      return out;
    }
  }
  if (!params) {
    return fallback;
  }
  return fallback.replace(/\{(\w+)\}/g, (match, token) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
  );
}

function rescanLabel() {
  return tr("preflight.rescan", "Rescan");
}

function formatNameList(names) {
  try {
    return new Intl.ListFormat(window.i18n?.getLocale?.() || "en", {
      style: "long",
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}

// The {rescan} token is merged into every verdict so main never owns a button label.
function verdictText(v) {
  return tr(v.reasonKey, v.reasonKey, { ...v.reasonParams, rescan: rescanLabel() });
}

// ─── Icons

const PATHS = {
  refresh:
    "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
  check: "M5 13l4 4L19 7",
  x: "M6 18L18 6M6 6l12 12",
  question:
    "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  warning:
    "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  lock: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
  clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  arrow: "M9 5l7 7-7 7",
};

function svgIcon(cls, d, strokeWidth) {
  return (
    `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="${strokeWidth || 2.5}" d="${d}"></path></svg>`
  );
}

const CARD_ICONS = {
  scanning: svgIcon("sc-icon spinning", PATHS.refresh, 2),
  pass: svgIcon("sc-icon", PATHS.check),
  fail: svgIcon("sc-icon", PATHS.x),
  unverified: svgIcon("sc-icon", PATHS.question, 2),
  warning: svgIcon("sc-icon", PATHS.warning, 2),
};

const SMALL_ICONS = {
  close: svgIcon("sc-icon-xs", PATHS.x, 2),
  x: svgIcon("sc-icon-xs", PATHS.x),
  check: svgIcon("sc-icon-xs", PATHS.check),
  spin: svgIcon("sc-icon-xs spinning", PATHS.refresh, 2),
  reopen: svgIcon("sc-icon-xs", PATHS.refresh, 2),
  lock: svgIcon("sc-icon-xs", PATHS.lock, 2),
  clock: svgIcon("sc-icon-xs", PATHS.clock, 2),
};

const PROCEED_ARROW = svgIcon("sc-icon", PATHS.arrow);
const PROCEED_SPINNER = svgIcon("sc-icon spinning", PATHS.refresh, 2);

// ─── Copy

const SCANNING_COPY = {
  hdmi: ["preflight.hdmiScanning", "Checking for extra monitors and screen mirroring…"],
  meeting: ["preflight.meetingScanning", "Checking for video call and meeting apps…"],
  screen: ["preflight.screenScanning", "Checking for screen recording and streaming apps…"],
  wireless: ["preflight.wirelessScanning", "Checking for remote access and screen casting apps…"],
  browser: ["preflight.browserScanning", "Checking for open web browsers…"],
  ai: ["preflight.aiScanning", "Checking for AI assistant apps…"],
};

// "starting" covers the agent's cold spawn, the only wait long enough that a
// bare "Checking" reads as a hang.
const AGENT_PHASE_COPY = {
  starting: {
    desc: ["preflightResults.agentStarting", "Starting the security scanner…"],
    badge: ["preflightResults.starting", "Starting"],
  },
  scanning: {
    desc: ["preflightResults.runningDeepScan", "Running a deeper system check…"],
    badge: ["preflightResults.scanning", "Checking"],
  },
};

const BADGE_COPY = {
  scanning: ["preflightResults.scanning", "Checking"],
  pass: ["preflightResults.ready", "Passed"],
  fail: ["preflightResults.actionRequired", "Action needed"],
  unverified: ["preflightResults.unverified", "Couldn't check"],
  required: ["preflightResults.required", "Required"],
};

// ─── State
// Every tr() string on the page is derived from this state so renderI18n()
// can repaint it in a new locale. Nothing here decides the gate on its own:
// Continue opens only on a completed scan whose canProceed came back true.

/** id -> {phase} | {verdict} | {interrupted: true} | {preview: true} */
const _cards = {};
PM.CHECK_IDS.forEach((id) => {
  _cards[id] = { phase: "scanning" };
});

let _scanToken = null;
let _scansStarted = 0;
let _pageState = "scanning"; // scanning | pass | fail | error
let _passValid = false;
let _liveState = null; // null | clean | dirty | unverified
let _liveCleanStreak = 0;
/** True while an automatic confirm runs without resetting the cards. */
let _quietScan = false;
/** Consecutive clean live reads per card, so a red card only turns green once the app stays gone. */
const _cardCleanStreak = {};
let _proceedLoading = false;

let _scanRetryCount = 0;
let _retryCapHit = false;
let _autoRescanCount = 0;
let _unverifiedStreak = 0;

/** The single pending programmatic rescan: {kind, timer, ticker}. */
let _scheduled = null;

let _killsInFlight = 0;
let _elevationsPending = 0;
let _canElevate = false;
/** The elevated retry is offered once per process. */
const _elevationTried = new Set();
/** Apps the candidate already agreed to close, so a retry doesn't ask again. */
const _killConfirmed = new Set();

let _supportAvailable = false;
let _bounce = PM.bounceReason(new URLSearchParams(window.location.search).get("reason"));

let _statusState = {
  key: "preflight.runningDiagnostics",
  fallback: "Checking your computer…",
  params: null,
  className: STATUS,
};

/** {names, trigger, resolve} while the kill confirmation is open. */
let _dialog = null;
let _diagnosticsNote = null;
let _proceedMarkup = "";

const _killRowState = new WeakMap();
const _killAllState = new WeakMap();
const _rowInfo = new WeakMap();

// Diagnostics, exported only through the Copy-diagnostics control.
let _appVersion = null;
let _lastScanId = null;
let _lastTimings = null;
let _lastVerdicts = [];
let _lastCanProceed = null;
let _lastScanError = null;

// ─── i18n repaint

/** Cosmetic only: no IPC, no scan, and the gate is re-derived, never widened. */
function renderI18n() {
  paintStatus();
  PM.CHECK_IDS.forEach(paintCard);
  document.querySelectorAll(".sc-kill-row").forEach((row) => {
    paintRowText(row);
    paintKillRow(row);
  });
  document.querySelectorAll(".sc-kill-all-btn").forEach(paintKillAllBtn);
  renderProceedButton();
  renderSupport();
  paintSummary();
  if (_dialog) {
    paintDialog();
  }
}

function setStatus(key, fallback, params, className) {
  _statusState = { key, fallback, params: params || null, className };
  paintStatus();
}

function statusText() {
  const params =
    typeof _statusState.params === "function" ? _statusState.params() : _statusState.params;
  return _statusState.key
    ? tr(_statusState.key, _statusState.fallback, params)
    : _statusState.fallback;
}

function paintStatus() {
  const el = document.getElementById("final-status");
  if (!el) {
    return;
  }
  el.textContent = statusText();
  el.className = _statusState.className;
}

function announce(text) {
  const el = document.getElementById("sc-announcer");
  if (!el || !text) {
    return;
  }
  // Cleared first so repeating the same sentence is still announced.
  el.textContent = "";
  setTimeout(() => {
    el.textContent = text;
  }, 60);
}

// ─── Continue gate

function proceedAllowed() {
  return _passValid && !_scanToken && (_liveState === null || _liveState === "clean");
}

function renderProceedGate() {
  const btn = document.getElementById("btn-proceed");
  if (!btn) {
    return;
  }
  if (_proceedLoading) {
    btn.disabled = true;
    btn.className = "sc-btn-proceed sc-btn-proceed--loading";
  } else if (proceedAllowed()) {
    btn.disabled = false;
    btn.className = "sc-btn-proceed sc-btn-proceed--enabled";
  } else {
    btn.disabled = true;
    btn.className = _scanToken
      ? "sc-btn-proceed sc-btn-proceed--loading"
      : "sc-btn-proceed sc-btn-proceed--disabled";
  }
  renderProceedButton();
}

function renderProceedButton() {
  const btn = document.getElementById("btn-proceed");
  if (!btn) {
    return;
  }
  const markup = _proceedLoading
    ? `${PROCEED_SPINNER}<span>${tr("preflightResults.loading", "Loading…")}</span>`
    : `<span>${tr("common.continue", "Continue")}</span>${PROCEED_ARROW}`;
  // Pushes land every couple of seconds; don't churn the DOM for nothing.
  if (markup !== _proceedMarkup) {
    btn.innerHTML = markup;
    _proceedMarkup = markup;
  }
}

// ─── Cards

function cardTone(id) {
  const s = _cards[id];
  if (s.phase) {
    return "scanning";
  }
  if (s.preview) {
    return "pass";
  }
  if (s.interrupted) {
    return "unverified";
  }
  return PM.toneOf(s.verdict.status);
}

function cardTones() {
  return PM.CHECK_IDS.map(cardTone);
}

function cardView(id) {
  const s = _cards[id];
  const tone = cardTone(id);

  if (s.phase) {
    if (id === "agent") {
      const copy = AGENT_PHASE_COPY[s.phase] || AGENT_PHASE_COPY.scanning;
      return { tone, icon: "scanning", desc: tr(...copy.desc), badge: tr(...copy.badge) };
    }
    return {
      tone,
      icon: "scanning",
      desc: tr(...SCANNING_COPY[id]),
      badge: tr(...BADGE_COPY.scanning),
    };
  }
  if (s.preview) {
    return { tone, icon: "pass", desc: PREVIEW_CARD_TEXT, badge: tr(...BADGE_COPY.pass) };
  }
  if (s.interrupted) {
    const desc =
      id === "agent"
        ? tr(
            "preflightResults.agentUnverified",
            "The deep scan didn't finish. Click {rescan} to try again.",
            { rescan: rescanLabel() }
          )
        : tr(
            "preflightResults.checkUnverified",
            "We couldn't complete this check. Click {rescan} to try again.",
            { rescan: rescanLabel() }
          );
    return { tone, icon: "unverified", desc, badge: tr(...BADGE_COPY.unverified) };
  }

  const desc = verdictText(s.verdict);
  const agentDown =
    id === "agent" &&
    tone === "fail" &&
    !(Array.isArray(s.verdict.threats) && s.verdict.threats.length > 0);
  if (agentDown) {
    return { tone, icon: "warning", desc, badge: tr(...BADGE_COPY.required) };
  }
  return { tone, icon: tone, desc, badge: tr(...BADGE_COPY[tone]) };
}

const TONE_CLASSES = ["scanning", "pass", "fail", "unverified"];

function paintCard(id) {
  const card = document.getElementById(`card-${id}`);
  const icon = document.getElementById(`icon-${id}`);
  const desc = document.getElementById(`desc-${id}`);
  const badge = document.getElementById(`badge-${id}`);
  if (!card || !icon || !desc || !badge) {
    return;
  }
  const view = cardView(id);

  TONE_CLASSES.forEach((t) => card.classList.toggle(`sc-card--${t}`, t === view.tone));
  card.setAttribute("aria-busy", String(view.tone === "scanning"));

  // Only swap the icon on a change, so the spinner doesn't restart every paint.
  if (icon.dataset.icon !== view.icon) {
    icon.innerHTML = CARD_ICONS[view.icon];
    icon.dataset.icon = view.icon;
  }
  icon.className = `sc-card__icon sc-card__icon--${view.tone}`;
  desc.className = `sc-card__desc sc-card__desc--${view.tone}`;
  desc.textContent = view.desc;
  badge.className = `sc-badge sc-badge--${view.tone}`;
  badge.textContent = view.badge;
}

function setCard(id, state) {
  _cards[id] = state;
  paintCard(id);
  syncActions(id);
  paintSummary();
}

function syncActions(id) {
  const actions = document.getElementById(`actions-${id}`);
  if (!actions) {
    return;
  }
  const v = _cards[id].verdict;
  const failing = !!v && PM.toneOf(v.status) === "fail";
  if (id === "agent") {
    syncThreatRows(actions, failing && Array.isArray(v.threats) ? v.threats : []);
  } else {
    syncAppRows(actions, failing && Array.isArray(v.blockedApps) ? v.blockedApps : []);
  }
}

// ─── Summary strip

function paintSummary() {
  const text = document.getElementById("summary-text");
  const meter = document.getElementById("summary-meter");
  const bar = document.getElementById("summary-bar");
  const hint = document.getElementById("first-run-hint");
  if (!text || !meter || !bar) {
    return;
  }
  const s = PM.summarize(cardTones());
  let tone = "scanning";
  let label;
  if ((_scanToken && !_quietScan) || _pageState === "scanning") {
    label = tr("preflightResults.summaryProgress", "{done} of {total} checks complete", {
      done: s.done,
      total: s.total,
    });
  } else if (_quietScan && s.attention === 0) {
    label = tr("preflightResults.checkingAgain", "Checking again…");
  } else if (proceedAllowed()) {
    tone = "pass";
    label = tr("preflightResults.summaryAllPassed", "All checks passed");
  } else if (s.attention > 0) {
    tone = "attention";
    label = tr(
      "preflightResults.summaryNeedAttention",
      s.attention === 1 ? "1 check needs attention" : "{count} checks need attention",
      { count: s.attention }
    );
  } else {
    label = tr("preflightResults.summaryProgress", "{done} of {total} checks complete", {
      done: s.done,
      total: s.total,
    });
  }

  text.textContent = label;
  meter.className = `sc-summary__meter sc-summary__meter--${tone}`;
  meter.setAttribute("aria-valuemax", String(s.total));
  meter.setAttribute("aria-valuenow", String(s.done));
  meter.setAttribute("aria-valuetext", label);
  bar.style.inlineSize = `${s.total ? Math.round((s.done / s.total) * 100) : 0}%`;
  if (hint) {
    hint.hidden = !(_scanToken && _scansStarted === 1);
  }
}

function summaryLine() {
  return document.getElementById("summary-text")?.textContent || "";
}

// ─── Scheduler

function cancelScheduledRescan() {
  if (_scheduled) {
    clearTimeout(_scheduled.timer);
    clearInterval(_scheduled.ticker);
    _scheduled = null;
  }
}

function scheduleRescan(delayMs, kind, onTick) {
  cancelScheduledRescan();
  const entry = { kind, timer: null, ticker: null };
  entry.timer = setTimeout(() => fireScheduledRescan(entry), delayMs);
  if (onTick) {
    entry.ticker = setInterval(onTick, 1000);
  }
  _scheduled = entry;
}

function canAutoScanNow() {
  return (
    !_scanToken && !_dialog && _killsInFlight === 0 && _elevationsPending === 0 && !_proceedLoading
  );
}

function fireScheduledRescan(entry) {
  if (_scheduled !== entry) {
    return;
  }
  clearInterval(entry.ticker);
  entry.ticker = null;
  if (!canAutoScanNow()) {
    entry.timer = setTimeout(() => fireScheduledRescan(entry), DEFER_RESCAN_MS);
    return;
  }
  _scheduled = null;
  runScans({ auto: true });
}

// ─── Scanning

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Manual scans reset the retry caps; programmatic ones keep counting against them. */
async function runScans({ auto = false } = {}) {
  if (_scanToken || _proceedLoading) {
    return;
  }
  cancelScheduledRescan();
  if (!auto) {
    _scanRetryCount = 0;
    _autoRescanCount = 0;
  }

  const token = PM.newScanToken();
  _scanToken = token;
  _scansStarted += 1;
  // Automatic confirms keep the cards as they are; only a first or manual scan redraws them.
  _quietScan = auto && _pageState !== "scanning";
  if (_quietScan) {
    beginQuietScanUi();
  } else {
    beginScanUi();
  }

  const api = window.electronAPI;
  if (!api) {
    setTimeout(() => {
      if (_scanToken === token) {
        _scanToken = null;
        setPreviewPassed();
      }
    }, 1000);
    return;
  }

  api.onPreflightProgress((payload) => {
    if (PM.belongsToScan(payload, _scanToken)) {
      applyVerdict(payload);
    }
  });

  let results = null;
  let error = null;
  try {
    results = await withTimeout(
      api.runPreflight(token),
      SCAN_TIMEOUT_MS,
      tr("preflightResults.tooLong", "That took too long. Please try again.")
    );
    if (!PM.belongsToScan(results, token)) {
      throw new Error(tr("preflightResults.unknownError", "Something went wrong."));
    }
  } catch (err) {
    error = err;
  } finally {
    api.removePreflightProgressListener?.();
  }

  if (_scanToken !== token) {
    return;
  }
  // Cleared before painting so late events from this scan are dropped too.
  _scanToken = null;
  const quiet = _quietScan;
  _quietScan = false;
  if (error) {
    console.error("[preflight] scan error:", error);
    showScanError(error?.message || tr("preflightResults.unknownError", "Something went wrong."));
  } else {
    finishScan(results, { quiet });
  }
}

function resetLiveTracking() {
  _liveState = null;
  _liveCleanStreak = 0;
  Object.keys(_cardCleanStreak).forEach((id) => delete _cardCleanStreak[id]);
}

function beginScanUi() {
  _passValid = false;
  resetLiveTracking();
  _pageState = "scanning";
  _lastVerdicts = [];

  PM.CHECK_IDS.forEach((id) => {
    _cards[id] = { phase: "scanning" };
    paintCard(id);
    syncActions(id);
  });

  if (_bounce) {
    setStatus(_bounce.key, _bounce.fallback, null, STATUS);
  } else {
    setStatus("preflight.runningDiagnostics", "Checking your computer…", null, STATUS);
  }
  const rescan = document.getElementById("btn-rescan");
  if (rescan) {
    rescan.disabled = true;
  }
  renderProceedGate();
  paintSummary();
}

function beginQuietScanUi() {
  _passValid = false;
  resetLiveTracking();
  _lastVerdicts = [];
  if (_bounce) {
    setStatus(_bounce.key, _bounce.fallback, null, STATUS);
  } else {
    setStatus("preflightResults.checkingAgain", "Checking again…", null, STATUS);
  }
  const rescan = document.getElementById("btn-rescan");
  if (rescan) {
    rescan.disabled = true;
  }
  renderProceedGate();
  paintSummary();
}

/** Streams in from progress events and again from the final result; idempotent. */
function applyVerdict(v) {
  if (!v || !PM.CHECK_IDS.includes(v.id)) {
    return;
  }
  // A phase is progress, never a result: nothing gated may ever see it.
  if (v.phase) {
    if (v.id === "agent" && _cards.agent.phase) {
      setCard("agent", { phase: v.phase });
    }
    return;
  }

  if (v.scanId) {
    _lastScanId = v.scanId;
  }
  const row = { id: v.id, status: v.status, reasonKey: v.reasonKey };
  const at = _lastVerdicts.findIndex((x) => x.id === v.id);
  if (at >= 0) {
    _lastVerdicts[at] = row;
  } else {
    _lastVerdicts.push(row);
  }

  const current = _cards[v.id].verdict;
  if (current && PM.sameVerdict(current, v)) {
    return;
  }
  setCard(v.id, { verdict: v });
}

/** Cards a scan never reported on can't be shown as still scanning, or as passed. */
function markInterrupted() {
  PM.CHECK_IDS.forEach((id) => {
    if (_cards[id].phase) {
      setCard(id, { interrupted: true });
    }
  });
}

function finishScan(results, { quiet = false } = {}) {
  const verdicts = Array.isArray(results?.verdicts) ? results.verdicts : [];
  const stateBefore = _pageState;
  verdicts.forEach(applyVerdict);
  markInterrupted();
  if (quiet) {
    const reported = new Set(verdicts.map((v) => v?.id));
    PM.CHECK_IDS.forEach((id) => {
      if (!reported.has(id) && !_cards[id].interrupted) {
        setCard(id, { interrupted: true });
      }
    });
  }

  _lastScanId = results?.scanId ?? null;
  _lastTimings = results?.timings ?? null;
  _lastCanProceed = results?.canProceed === true;
  _lastVerdicts = verdicts.map((v) => ({ id: v.id, status: v.status, reasonKey: v.reasonKey }));
  _lastScanError = null;

  // Fail-closed: a malformed or empty response never opens the gate.
  _passValid = results?.canProceed === true && verdicts.length > 0;
  resetLiveTracking();
  _scanRetryCount = 0;
  _retryCapHit = false;
  _bounce = null;

  const tones = cardTones();
  _unverifiedStreak = tones.includes("unverified") ? _unverifiedStreak + 1 : 0;

  if (_passValid) {
    _autoRescanCount = 0;
    _pageState = "pass";
    setStatus(
      "preflightResults.allPassed",
      "All checks passed. You can continue.",
      null,
      STATUS_PASS
    );
  } else {
    _pageState = "fail";
    // "Close something" and "we couldn't check" call for different actions.
    if (tones.includes("fail")) {
      setStatus(
        "preflightResults.resolveAlerts",
        "Fix the items marked above, then click {rescan}.",
        () => ({ rescan: rescanLabel() }),
        STATUS_FAIL
      );
    } else {
      setStatus(
        "preflightResults.someUnverified",
        "Some checks couldn't be completed. Click {rescan} to try again.",
        () => ({ rescan: rescanLabel() }),
        STATUS_FAIL
      );
    }
  }

  const rescan = document.getElementById("btn-rescan");
  if (rescan) {
    rescan.disabled = false;
  }
  renderProceedGate();
  renderSupport();
  paintSummary();
  if (!quiet || _pageState !== stateBefore) {
    announce(`${summaryLine()}. ${statusText()}`);
  }
  if (!_passValid && !quiet) {
    focusFirstProblem();
  }
}

function showScanError(message) {
  _pageState = "error";
  _passValid = false;
  _lastScanError = message;
  _bounce = null;
  markInterrupted();

  const rescan = document.getElementById("btn-rescan");
  if (rescan) {
    rescan.disabled = false;
  }

  const decision = PM.scanErrorDecision(_scanRetryCount, MAX_SCAN_RETRIES);
  if (!decision.retry) {
    _retryCapHit = true;
    setStatus(
      "preflightResults.diagnosticsFailedRetry",
      "The check didn't finish ({message}). Click {rescan} to try again.",
      () => ({ message, rescan: rescanLabel() }),
      STATUS_FAIL
    );
  } else {
    _scanRetryCount = decision.attempt;
    const attempt = decision.attempt;
    const deadline = Date.now() + RETRY_COUNTDOWN_MS;
    setStatus(
      "preflightResults.diagnosticsFailedCountdown",
      "The check didn't finish ({message}). Trying again in {seconds}s… ({attempt})",
      () => ({
        message,
        seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
        attempt: tr("preflightResults.attempt", "attempt {current} of {max}", {
          current: attempt,
          max: MAX_SCAN_RETRIES,
        }),
      }),
      STATUS_WARN
    );
    scheduleRescan(RETRY_COUNTDOWN_MS, "retry", paintStatus);
  }

  renderProceedGate();
  renderSupport();
  paintSummary();
  announce(statusText());
}

function setPreviewPassed() {
  PM.CHECK_IDS.forEach((id) => setCard(id, { preview: true }));
  _passValid = true;
  _pageState = "pass";
  setStatus(null, PREVIEW_STATUS_TEXT, null, STATUS_PASS);
  const rescan = document.getElementById("btn-rescan");
  if (rescan) {
    rescan.disabled = false;
  }
  renderProceedGate();
  paintSummary();
}

/** After a scan with failures, land keyboard and screen-reader users on the first one. */
function focusFirstProblem() {
  if (_dialog || document.hidden) {
    return;
  }
  const active = document.activeElement;
  const idle =
    !active ||
    active === document.body ||
    active.id === "btn-rescan" ||
    active.id === "btn-proceed";
  if (!idle) {
    return;
  }
  const tones = cardTones();
  let index = tones.indexOf("fail");
  if (index < 0) {
    index = tones.indexOf("unverified");
  }
  if (index < 0) {
    return;
  }
  document.getElementById(`card-${PM.CHECK_IDS[index]}`)?.querySelector(".sc-card__title")?.focus();
}

// ─── Live status (monitor pushes while this page is shown)

function onLiveStatus(payload) {
  // Still recorded while Continue is loading, so a watchdog restore sees the latest state.
  if (_scanToken || _pageState === "scanning") {
    return;
  }
  const live = PM.readLiveStatus(payload);

  live.verdicts.forEach((v) => {
    const cardClear = PM.debounceClear(
      PM.toneOf(v.status) === "pass",
      _cardCleanStreak[v.id] || 0,
      LIVE_CLEAN_TICKS
    );
    _cardCleanStreak[v.id] = cardClear.streak;
    const current = _cards[v.id].verdict;
    if (current && PM.sameVerdict(current, v)) {
      return;
    }
    if (!cardClear.settled && current && PM.toneOf(current.status) !== "pass") {
      return;
    }
    setCard(v.id, { verdict: v });
  });

  const pageClear = PM.debounceClear(live.state === "clean", _liveCleanStreak, LIVE_CLEAN_TICKS);
  _liveCleanStreak = pageClear.streak;
  if (!pageClear.settled) {
    renderProceedGate();
    paintSummary();
    return;
  }

  if (_passValid) {
    const previous = _liveState;
    _liveState = live.state;
    paintLiveStatus(live);
    if (previous !== live.state && !(previous === null && live.state === "clean")) {
      announce(statusText());
    }
  } else if (
    _pageState === "fail" &&
    live.state === "clean" &&
    cardTones().every((t) => t === "pass") &&
    !_scheduled &&
    _autoRescanCount < MAX_AUTO_RESCANS
  ) {
    // The candidate closed things themselves; confirm with a real scan.
    _autoRescanCount += 1;
    setStatus(
      "preflightResults.liveClearedRescanning",
      "Looks clear now. Checking again…",
      null,
      STATUS
    );
    scheduleRescan(LIVE_CLEAR_RESCAN_DELAY_MS, "live");
  }

  renderProceedGate();
  paintSummary();
}

function paintLiveStatus(live) {
  if (live.state === "clean") {
    setStatus(
      "preflightResults.allPassed",
      "All checks passed. You can continue.",
      null,
      STATUS_PASS
    );
    return;
  }
  if (live.state === "unverified") {
    setStatus(
      "preflightResults.liveUnverified",
      "We couldn't re-check your computer just now. Click {rescan} to check again.",
      () => ({ rescan: rescanLabel() }),
      STATUS_WARN
    );
    return;
  }
  if (live.apps.length > 0) {
    const apps = live.apps.map(getDisplayName);
    setStatus(
      "preflightResults.blockedAppLaunched",
      apps.length === 1
        ? "{names} was opened after the check. Close it to continue."
        : "{names} were opened after the check. Close them to continue.",
      () => ({ names: formatNameList(apps), count: apps.length }),
      STATUS_FAIL
    );
    return;
  }
  if (live.displayChanged) {
    setStatus(
      "preflightResults.liveDisplayChanged",
      "Your display setup changed. Disconnect external displays to continue.",
      null,
      STATUS_FAIL
    );
    return;
  }
  setStatus(
    "preflightResults.resolveAlerts",
    "Fix the items marked above, then click {rescan}.",
    () => ({ rescan: rescanLabel() }),
    STATUS_FAIL
  );
}

// ─── Kill rows

function uniqueStrings(list) {
  return [...new Set(list.filter((x) => typeof x === "string" && x.length > 0))];
}

/** Keeps rows that are still wanted (with their kill state), drops the rest, appends new ones. */
function syncRows(container, items) {
  const wanted = new Set(items.map((i) => i.key));
  const existing = new Map();
  container.querySelectorAll(":scope > .sc-kill-row").forEach((row) => {
    if (wanted.has(row.dataset.key) && !existing.has(row.dataset.key)) {
      existing.set(row.dataset.key, row);
    } else {
      row.remove();
    }
  });
  const anchor = container.querySelector(":scope > .sc-kill-all-btn");
  items.forEach((item) => {
    if (!existing.has(item.key)) {
      container.insertBefore(item.build(), anchor);
    }
  });
}

function syncAppRows(container, apps) {
  const names = uniqueStrings(apps);
  syncRows(
    container,
    names.map((name) => ({
      key: name,
      build: () => buildKillRow({ kind: "app", processName: name, killable: true }),
    }))
  );

  let all = container.querySelector(":scope > .sc-kill-all-btn");
  if (names.length > 1) {
    if (!all) {
      all = document.createElement("button");
      all.type = "button";
      all.addEventListener("click", () => handleKillAll(all));
      container.appendChild(all);
      setKillAllState(all, { kind: "idle" });
    } else {
      paintKillAllBtn(all);
    }
  } else if (all) {
    all.remove();
  }
}

function syncThreatRows(container, threats) {
  const canKill = typeof window.electronAPI?.killThreatProcess === "function";
  syncRows(
    container,
    threats.map((t, i) => {
      const processName = PM.processLabel(t?.process);
      const key = `${i}|${t?.type}|${t?.pid}|${processName}`;
      return {
        key,
        build: () =>
          buildKillRow({
            kind: "threat",
            key,
            threat: t || {},
            processName,
            pid: PM.isKillableThreat(t) ? t.pid : null,
            killable: canKill && PM.isKillableThreat(t),
          }),
      };
    })
  );
}

/** Process names and threat fields are attacker-influenceable: text nodes only. */
function buildKillRow(info) {
  const row = document.createElement("div");
  row.className = info.kind === "threat" ? "sc-kill-row sc-kill-row--threat" : "sc-kill-row";
  row.dataset.key = info.key || info.processName;
  row.dataset.process = info.processName || "";
  if (info.pid) {
    row.dataset.pid = String(info.pid);
  }
  _rowInfo.set(row, info);

  const dot = document.createElement("span");
  dot.className = "sc-kill-dot";
  dot.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  text.className = "sc-kill-info";
  const name = document.createElement("span");
  name.className = "sc-kill-name";
  const sub = document.createElement("span");
  sub.className = "sc-kill-process";
  text.append(name, sub);
  row.append(dot, text);

  if (info.kind === "threat") {
    const badge = document.createElement("span");
    badge.className = "sc-threat-badge";
    row.appendChild(badge);
  }

  if (info.killable) {
    row.dataset.killable = "true";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sc-kill-btn";
    btn.addEventListener("click", () => onKillClick(row));
    row.appendChild(btn);
  }

  const hint = document.createElement("p");
  hint.className = "sc-kill-hint";
  hint.hidden = true;
  row.appendChild(hint);

  if (info.kind === "threat" && PM.threatHint(info.threat.type)) {
    const guide = document.createElement("p");
    guide.className = "sc-threat-hint";
    row.appendChild(guide);
  }

  paintRowText(row);
  if (info.killable) {
    setKillRowState(row, { kind: "idle" });
  }
  return row;
}

function rowDisplayName(row) {
  return getDisplayName(row.dataset.process || "");
}

function paintRowText(row) {
  const info = _rowInfo.get(row);
  if (!info) {
    return;
  }
  const name = row.querySelector(".sc-kill-name");
  const sub = row.querySelector(".sc-kill-process");
  if (info.kind === "threat") {
    const title = PM.threatTitle(info.threat.type);
    name.textContent = tr(title.key, title.fallback);
    sub.textContent = info.processName ? rowDisplayName(row) : "";
    const severity = PM.severityInfo(info.threat.severity);
    const badge = row.querySelector(".sc-threat-badge");
    if (badge) {
      badge.className = `sc-threat-badge sc-threat-badge--${severity.tone}`;
      badge.textContent = severity.key ? tr(severity.key, severity.fallback) : severity.fallback;
      badge.hidden = !badge.textContent;
    }
    const guide = row.querySelector(".sc-threat-hint");
    const hint = PM.threatHint(info.threat.type);
    if (guide && hint) {
      guide.textContent = tr(hint.key, hint.fallback);
    }
  } else {
    const display = rowDisplayName(row);
    name.textContent = display;
    sub.textContent = display !== info.processName ? info.processName : "";
  }
  sub.hidden = !sub.textContent;
}

function setKillRowState(row, state) {
  _killRowState.set(row, state);
  paintKillRow(row);
}

function setHint(row, text, tone) {
  const hint = row.querySelector(".sc-kill-hint");
  if (!hint) {
    return;
  }
  hint.hidden = !text;
  hint.textContent = text || "";
  hint.className = tone ? `sc-kill-hint sc-kill-hint--${tone}` : "sc-kill-hint";
}

function setKillButton(btn, variant, disabled, icon, label) {
  btn.className = variant ? `sc-kill-btn sc-kill-btn--${variant}` : "sc-kill-btn";
  btn.disabled = disabled;
  btn.innerHTML = `${icon}<span>${label}</span>`;
}

const ROW_MODIFIERS = ["sc-kill-row--closed", "sc-kill-row--respawned", "sc-kill-row--blocked"];

function killHintText(view, display) {
  const params = { name: display, rescan: rescanLabel() };
  switch (view) {
    case "elevate":
      return tr(
        "preflightResults.killElevateHint",
        "{name} needs administrator rights. Your system will ask you to confirm before it closes.",
        params
      );
    case "respawned":
      return tr(
        "preflightResults.killRespawnedHint",
        "{name} reopened after closing. Turn off its auto-start setting or sign out of it, then click {rescan}.",
        params
      );
    case "admin":
      return tr(
        "preflightResults.killAdminHint",
        "{name} needs administrator rights to close. Close it from its own window, then click {rescan}.",
        params
      );
    case "still-running":
      return tr(
        "preflightResults.killStillClosingHint",
        "{name} is still shutting down. Wait a few seconds, then click Close again.",
        params
      );
    case "failed":
      return tr(
        "preflightResults.killGenericHint",
        "We couldn't close {name}. Close it yourself, then click {rescan}.",
        params
      );
    default:
      return "";
  }
}

function paintKillRow(row) {
  const btn = row.querySelector(".sc-kill-btn");
  const state = _killRowState.get(row);
  if (!btn || !state) {
    return;
  }
  const display = rowDisplayName(row);
  row.classList.remove(...ROW_MODIFIERS);
  btn.removeAttribute("aria-label");

  if (state.kind === "idle") {
    setHint(row, null);
    setKillButton(btn, null, false, SMALL_ICONS.close, tr("preflightResults.close", "Close"));
    btn.setAttribute(
      "aria-label",
      tr("preflightResults.closeApp", "Close {name}", { name: display })
    );
    return;
  }
  if (state.kind === "closing") {
    setHint(row, null);
    const label = state.elevated
      ? tr("preflightResults.killElevateWaiting", "Waiting for your permission…")
      : tr("preflightResults.closing", "Closing…");
    setKillButton(btn, "busy", true, SMALL_ICONS.spin, label);
    return;
  }
  if (state.kind === "error") {
    setHint(row, killHintText("failed", display), "fail");
    setKillButton(
      btn,
      "failed",
      false,
      SMALL_ICONS.x,
      tr("preflightResults.closeErrorManual", "Something went wrong — try again")
    );
    return;
  }

  switch (state.view) {
    case "closed":
    case "already-gone":
      setHint(row, null);
      row.classList.add("sc-kill-row--closed");
      setKillButton(
        btn,
        "killed",
        true,
        SMALL_ICONS.check,
        state.view === "already-gone"
          ? tr("preflightResults.alreadyClosed", "Already closed")
          : tr("preflightResults.closed", "Closed")
      );
      return;
    case "elevate":
      row.classList.add("sc-kill-row--blocked");
      setHint(row, killHintText("elevate", display), "fail");
      setKillButton(
        btn,
        "elevate",
        false,
        SMALL_ICONS.lock,
        tr("preflightResults.killElevateBtn", "Close with admin rights")
      );
      return;
    case "respawned":
      row.classList.add("sc-kill-row--respawned");
      setHint(row, killHintText("respawned", display), "fail");
      setKillButton(
        btn,
        "respawned",
        true,
        SMALL_ICONS.reopen,
        tr("preflightResults.killRespawnedBtn", "Reopened itself")
      );
      return;
    case "admin":
      row.classList.add("sc-kill-row--blocked");
      setHint(row, killHintText("admin", display), "fail");
      setKillButton(
        btn,
        "blocked",
        true,
        SMALL_ICONS.lock,
        tr("preflightResults.killAdminBtn", "Needs admin rights")
      );
      return;
    case "still-running":
      setHint(row, killHintText("still-running", display), "pending");
      setKillButton(
        btn,
        "retry",
        false,
        SMALL_ICONS.clock,
        tr("preflightResults.killStillClosingBtn", "Still closing — try again")
      );
      return;
    default:
      setHint(row, killHintText("failed", display), "fail");
      setKillButton(
        btn,
        "failed",
        false,
        SMALL_ICONS.x,
        tr("preflightResults.closeFailedManual", "Couldn't close — try again")
      );
  }
}

function openKillableRows(scope) {
  return [...scope.querySelectorAll(".sc-kill-row[data-killable]:not(.sc-kill-row--closed)")];
}

function setKillAllState(btn, state) {
  _killAllState.set(btn, state);
  paintKillAllBtn(btn);
}

const KILL_ALL_SUMMARY = {
  "all-closed": [
    "success",
    "check",
    "preflightResults.allClosedRescanning",
    "All closed — checking again…",
  ],
  reopened: ["failed", "x", "preflightResults.killAllReopened", "Some apps reopened themselves"],
  failed: ["failed", "x", "preflightResults.someFailedToClose", "Some apps couldn't be closed"],
  partial: [
    "partial",
    "x",
    "preflightResults.killAllPartial",
    "{closed} of {total} closed — close the rest yourself",
  ],
};

function paintKillAllBtn(btn) {
  const state = _killAllState.get(btn);
  if (!state) {
    return;
  }
  if (state.kind === "idle") {
    const count = btn.parentElement
      ? openKillableRows(btn.parentElement).filter((r) => !r.dataset.pid).length
      : 0;
    btn.hidden = count < 2;
    btn.disabled = false;
    btn.className = "sc-kill-all-btn";
    btn.innerHTML = `${svgIcon("sc-icon-sm", PATHS.x)}<span>${tr(
      "preflightResults.closeAll",
      "Close all {count} apps",
      { count }
    )}</span>`;
    return;
  }
  if (state.kind === "killing") {
    btn.disabled = true;
    btn.className = "sc-kill-all-btn sc-kill-all-btn--busy";
    btn.innerHTML = `${svgIcon("sc-icon-sm spinning", PATHS.refresh, 2)}<span>${tr(
      "preflightResults.closingAll",
      "Closing apps…"
    )}</span>`;
    return;
  }
  const [variant, icon, key, fallback] = KILL_ALL_SUMMARY[state.summary] || KILL_ALL_SUMMARY.failed;
  btn.disabled = true;
  btn.className = `sc-kill-all-btn sc-kill-all-btn--${variant}`;
  btn.innerHTML = `${svgIcon("sc-icon-sm", PATHS[icon])}<span>${tr(key, fallback, {
    closed: state.closed,
    total: state.total,
  })}</span>`;
}

function refreshKillAll(container) {
  const all = container?.querySelector(":scope > .sc-kill-all-btn");
  if (all && _killAllState.get(all)?.kind === "idle") {
    paintKillAllBtn(all);
  }
}

function beginKill(elevated) {
  _killsInFlight += 1;
  if (elevated) {
    _elevationsPending += 1;
    updateBackButton();
  }
}

function endKill(elevated) {
  _killsInFlight = Math.max(0, _killsInFlight - 1);
  if (elevated) {
    _elevationsPending = Math.max(0, _elevationsPending - 1);
    updateBackButton();
  }
}

// Leaving mid-prompt would strand an elevation dialog the candidate can't tie to anything.
function updateBackButton() {
  const back = document.getElementById("btn-back-dashboard");
  if (back) {
    back.disabled = _elevationsPending > 0;
  }
}

function requestKill(processName, pid, elevated) {
  const api = window.electronAPI;
  if (pid) {
    return api.killThreatProcess(pid, processName);
  }
  return elevated ? api.killProcessElevated(processName) : api.killProcess(processName);
}

/** Paints a row from its KillResult and returns the outcome category. */
function applyKillResult(row, raw) {
  const processName = row.dataset.process;
  const norm = PM.normalizeKillResult(raw, processName);
  const { category, view } = PM.killOutcomeView(norm, {
    canElevate: _canElevate && !row.dataset.pid,
    elevationTried: _elevationTried.has(processName),
  });
  setKillRowState(row, { kind: "outcome", view });
  return { category, view };
}

async function killRow(row, elevated) {
  const processName = row.dataset.process;
  const pid = row.dataset.pid ? Number(row.dataset.pid) : null;
  // Recorded before the prompt so a declined or failed elevation is never re-offered.
  if (elevated) {
    _elevationTried.add(processName);
  }
  setKillRowState(row, { kind: "closing", elevated });
  beginKill(elevated);
  let raw;
  let threw = false;
  try {
    raw = await requestKill(processName, pid, elevated);
  } catch {
    threw = true;
  } finally {
    endKill(elevated);
  }
  if (threw) {
    setKillRowState(row, { kind: "error" });
    return { category: "failed", view: "failed" };
  }
  return applyKillResult(row, raw);
}

async function onKillClick(row) {
  const btn = row.querySelector(".sc-kill-btn");
  const state = _killRowState.get(row);
  if (!btn || btn.disabled || !state) {
    return;
  }
  const processName = row.dataset.process;
  const elevated = state.kind === "outcome" && state.view === "elevate";
  if (!elevated && !_killConfirmed.has(processName)) {
    const ok = await confirmKill([processName], btn);
    if (!ok || !row.isConnected) {
      return;
    }
    _killConfirmed.add(processName);
  }

  const { category, view } = await killRow(row, elevated);
  // A rescan or live update replaced this row meanwhile; it owns the page now.
  if (!row.isConnected) {
    return;
  }
  refreshKillAll(row.parentElement);
  restoreKillFocus(row);

  const display = rowDisplayName(row);
  const hint = row.querySelector(".sc-kill-hint");
  if (category === "closed") {
    announce(tr("preflightResults.appClosed", "{name} closed.", { name: display }));
  } else {
    announce(hint && !hint.hidden ? hint.textContent : btn.textContent);
  }

  if (category === "closed") {
    if (openKillableRows(document).length === 0) {
      scheduleKillRescan();
    }
  } else if (view === "elevate") {
    // The row now offers the admin retry; nothing to rescan yet.
  } else if (category === "respawned") {
    scheduleKillRescan({ respawned: [display] });
  } else if (category === "access-denied") {
    scheduleKillRescan({ accessDenied: [display] });
  }
}

function restoreKillFocus(row) {
  const active = document.activeElement;
  if (active && active !== document.body) {
    return;
  }
  const btn = row.querySelector(".sc-kill-btn");
  if (btn && !btn.disabled) {
    btn.focus();
  } else {
    row.closest(".sc-card")?.querySelector(".sc-card__title")?.focus();
  }
}

async function handleKillAll(btn) {
  const container = btn.parentElement;
  if (!container || btn.disabled) {
    return;
  }
  const rows = openKillableRows(container).filter((r) => !r.dataset.pid);
  const names = rows.map((r) => r.dataset.process);
  if (names.length === 0) {
    return;
  }
  const ok = await confirmKill(names, btn);
  if (!ok || !btn.isConnected) {
    return;
  }
  names.forEach((n) => _killConfirmed.add(n));

  setKillAllState(btn, { kind: "killing" });
  rows.forEach((row) => setKillRowState(row, { kind: "closing", elevated: false }));
  beginKill(false);
  let results;
  let threw = false;
  try {
    results = await window.electronAPI.killAllProcesses(names);
  } catch {
    threw = true;
  } finally {
    endKill(false);
  }

  // A missing entry is a failure, never a success.
  const lookup = PM.indexKillResults(threw ? [] : results);
  const evidence = { respawned: [], accessDenied: [] };
  const categories = rows.map((row) => {
    const { category, view } = applyKillResult(row, lookup(row.dataset.process));
    if (view !== "elevate" && category === "respawned") {
      evidence.respawned.push(rowDisplayName(row));
    } else if (view !== "elevate" && category === "access-denied") {
      evidence.accessDenied.push(rowDisplayName(row));
    }
    return category;
  });

  const outcome = PM.killAllOutcome(categories);
  setKillAllState(btn, { kind: "summary", ...outcome });
  if (!btn.isConnected) {
    return;
  }
  announce(btn.textContent);
  if (document.activeElement === document.body) {
    container.closest(".sc-card")?.querySelector(".sc-card__title")?.focus();
  }

  if (outcome.rescan === "evidence") {
    if (evidence.respawned.length > 0 || evidence.accessDenied.length > 0) {
      scheduleKillRescan(evidence);
    }
  } else if (outcome.rescan === "plain") {
    scheduleKillRescan();
  }
}

/** Names what a rescan can't fix instead of burning retries on it. */
function scheduleKillRescan(evidence) {
  const respawned = evidence?.respawned || [];
  const accessDenied = evidence?.accessDenied || [];
  const decision = PM.autoRescanDecision({
    respawned,
    accessDenied,
    count: _autoRescanCount,
    max: MAX_AUTO_RESCANS,
  });
  const withNames = (list) => () => ({
    names: formatNameList(list),
    count: list.length,
    rescan: rescanLabel(),
  });

  if (decision === "halt-respawned") {
    setStatus(
      "preflightResults.appsRespawnedStop",
      respawned.length === 1
        ? "{names} reopened after closing. Turn off its auto-start setting or sign out of it, then click {rescan}."
        : "{names} reopened after closing. Turn off their auto-start setting or sign out of them, then click {rescan}.",
      withNames(respawned),
      STATUS_FAIL
    );
    announce(statusText());
    return;
  }
  if (decision === "halt-admin") {
    setStatus(
      "preflightResults.appsNeedAdminStop",
      accessDenied.length === 1
        ? "{names} needs administrator rights to close. Close it yourself, then click {rescan}."
        : "{names} need administrator rights to close. Close them yourself, then click {rescan}.",
      withNames(accessDenied),
      STATUS_FAIL
    );
    announce(statusText());
    return;
  }
  if (decision === "halt-cap") {
    setStatus(
      "preflightResults.appsReopening",
      "Some apps keep reopening. Close them yourself, then click {rescan}.",
      () => ({ rescan: rescanLabel() }),
      STATUS_FAIL
    );
    announce(statusText());
    return;
  }
  _autoRescanCount += 1;
  setStatus("preflightResults.checkingAgain", "Checking again…", null, STATUS);
  scheduleRescan(KILL_RESCAN_DELAY_MS, "kill");
}

// ─── Kill confirmation dialog

function confirmKill(processNames, trigger) {
  const dlg = document.getElementById("kill-dialog");
  if (!dlg || typeof dlg.showModal !== "function") {
    return Promise.resolve(false);
  }
  if (_dialog) {
    closeDialog(false);
  }
  return new Promise((resolve) => {
    _dialog = { names: [...processNames], trigger, resolve };
    paintDialog();
    dlg.showModal();
    document.getElementById("kill-dialog-cancel")?.focus();
  });
}

function closeDialog(confirmed) {
  if (!_dialog) {
    return;
  }
  const { trigger, resolve } = _dialog;
  _dialog = null;
  const dlg = document.getElementById("kill-dialog");
  if (dlg?.open) {
    dlg.close();
  }
  if (trigger?.isConnected && !trigger.disabled) {
    trigger.focus();
  }
  resolve(confirmed);
}

function paintDialog() {
  if (!_dialog) {
    return;
  }
  const count = _dialog.names.length;
  const one = count === 1;
  const title = document.getElementById("kill-dialog-title");
  const body = document.getElementById("kill-dialog-body");
  const list = document.getElementById("kill-dialog-list");
  const confirm = document.getElementById("kill-dialog-confirm");
  const cancel = document.getElementById("kill-dialog-cancel");

  title.textContent = tr(
    "preflightResults.killConfirmTitle",
    one ? "Close this app?" : "Close these {count} apps?",
    { count }
  );
  body.textContent = tr(
    "preflightResults.killConfirmBody",
    one
      ? "Any unsaved work in it will be lost. Save your work first if you need to."
      : "Any unsaved work in them will be lost. Save your work first if you need to.",
    { count }
  );
  list.replaceChildren(
    ..._dialog.names.map((name) => {
      const li = document.createElement("li");
      li.textContent = getDisplayName(name);
      return li;
    })
  );
  confirm.textContent = tr(
    "preflightResults.killConfirmAction",
    one ? "Close app" : "Close {count} apps",
    { count }
  );
  cancel.textContent = tr("preflightResults.killConfirmCancel", "Cancel");
}

function wireDialog() {
  const dlg = document.getElementById("kill-dialog");
  if (!dlg) {
    return;
  }
  document
    .getElementById("kill-dialog-cancel")
    ?.addEventListener("click", () => closeDialog(false));
  document
    .getElementById("kill-dialog-confirm")
    ?.addEventListener("click", () => closeDialog(true));
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(false);
  });
  dlg.addEventListener("close", () => {
    if (!dlg.open) {
      closeDialog(false);
    }
  });
  // A click on the dialog element itself is a click on its backdrop.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) {
      closeDialog(false);
    }
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") {
      return;
    }
    const focusable = [...dlg.querySelectorAll("button:not(:disabled)")];
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// ─── Help and support

function renderSupport() {
  const helpBtn = document.getElementById("btn-help-support");
  if (helpBtn) {
    helpBtn.hidden = !_supportAvailable;
  }

  const wrap = document.getElementById("support-wrap");
  if (!wrap) {
    return;
  }
  const show = PM.shouldOfferSupport({
    unverifiedStreak: _unverifiedStreak,
    retryCapHit: _retryCapHit,
  });
  wrap.hidden = !show;
  if (!show) {
    _diagnosticsNote = null;
    wrap.querySelector("textarea")?.remove();
  }

  const text = document.getElementById("support-text");
  if (text) {
    text.textContent = tr(
      "preflightResults.supportPrompt",
      "Still stuck? Copy the diagnostics and include them when you ask for help."
    );
  }
  const diag = document.getElementById("btn-diagnostics");
  if (diag) {
    diag.textContent = tr("preflightResults.copyDiagnostics", "Copy diagnostics");
  }
  const contact = document.getElementById("btn-contact-support");
  if (contact) {
    contact.hidden = !_supportAvailable;
    contact.textContent = tr("preflightResults.contactSupport", "Contact support");
  }
  const note = document.getElementById("diagnostics-note");
  if (note) {
    const copy = DIAGNOSTICS_NOTE_COPY[_diagnosticsNote];
    note.textContent = copy ? tr(copy.key, copy.fallback) : "";
    note.hidden = !copy;
  }
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

function openSupport() {
  window.electronAPI?.openSupport?.();
}

async function onCopyDiagnostics() {
  const btn = document.getElementById("btn-diagnostics");
  const wrap = document.getElementById("support-wrap");
  if (!btn || !wrap) {
    return;
  }
  btn.disabled = true;
  let text = "";
  try {
    text = await buildDiagnosticsText();
  } catch (e) {
    console.error("[preflight] diagnostics build failed:", e);
  }
  const copied = text ? await copyToClipboard(text) : false;
  _diagnosticsNote = copied ? "copied" : "failed";
  renderSupport();
  if (copied) {
    wrap.querySelector("textarea")?.remove();
  } else {
    let ta = wrap.querySelector("textarea");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.className = "sc-support__text-dump";
      ta.setAttribute("readonly", "");
      ta.rows = 8;
      wrap.appendChild(ta);
    }
    ta.value = text;
    ta.select();
  }
  btn.disabled = false;
  announce(document.getElementById("diagnostics-note")?.textContent);
}

function toggleExplainer() {
  const btn = document.getElementById("btn-what-we-check");
  const panel = document.getElementById("what-we-check");
  if (!btn || !panel) {
    return;
  }
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
}

// ─── Diagnostics export
// Built from an explicit allow-list: no tokens, paths, identity, or process
// names beyond what's already on screen. Audit entries are re-projected field
// by field so a new audit field can't leak into a support paste.

const MAX_DIAGNOSTIC_AUDIT_ENTRIES = 15;

function pad(text, width) {
  const s = String(text ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

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
    const apps = Array.isArray(d.blockedApps) ? d.blockedApps.join(",") : "";
    return (
      `  ${ts} tick display=${d.hdmiStatus} process=${d.processStatus} ` +
      `agentReachable=${d.agentReachable} blockedApps=[${apps}]`
    );
  }

  if (entry?.type === "violation") {
    // The event string is free text built from threat details, so it stays out.
    return `  ${ts} violation severity=${d.severity} count=${d.count} hardBlock=${d.isHardBlock}`;
  }

  return null;
}

function findAuditField(auditEntries, field) {
  for (let i = auditEntries.length - 1; i >= 0; i -= 1) {
    const v = auditEntries[i]?.data?.[field];
    if (v) {
      return v;
    }
  }
  return null;
}

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
    `agentVersion:  ${findAuditField(audit, "agentVersion") || "unknown"}`,
    `agentSource:   ${String(findAuditField(audit, "agentSourceSha") || "unknown").slice(0, 12)}`,
    `agentExpected: ${String(findAuditField(audit, "agentSourceExpected") || "none").slice(0, 12)}`,
    `platform:      ${navigator.platform || "unknown"}`,
    `locale:        ${window.i18n?.getLocale?.() || document.documentElement.lang || "unknown"}`,
    `scanId:        ${_lastScanId || "none"}`,
    `canProceed:    ${_lastCanProceed === null ? "unknown" : _lastCanProceed}`,
    `liveState:     ${_liveState || "none"}`,
    `consecutiveScanFailures: ${_scanRetryCount}`,
    `consecutiveUnverifiedScans: ${_unverifiedStreak}`,
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

// navigator.clipboard may be missing on file://, so fall back to execCommand.
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

// ─── Wiring

function onProceedClick() {
  const btn = document.getElementById("btn-proceed");
  if (!btn || btn.disabled || !proceedAllowed()) {
    return;
  }
  if (typeof window.electronAPI?.loadPermissionsPage !== "function") {
    setStatus(
      "preflightResults.restartApp",
      "Unable to continue. Please restart the app.",
      null,
      STATUS_FAIL
    );
    return;
  }
  cancelScheduledRescan();
  _proceedLoading = true;
  renderProceedGate();
  // Navigation tears this page down; if the timer still fires, it never happened.
  const watchdog = window.armButtonRestore(btn, btn.innerHTML, {
    onRestore: () => {
      _proceedLoading = false;
      _proceedMarkup = "";
      renderProceedGate();
      setStatus(
        "preflightResults.tooLong",
        "That took too long. Please try again.",
        null,
        STATUS_FAIL
      );
    },
  });
  Promise.resolve(window.electronAPI.loadPermissionsPage())
    .then((res) => {
      if (res && res.ok === false) {
        clearTimeout(watchdog);
        onProceedRefused(res.reason);
      }
    })
    .catch(() => {});
}

/** Main said no (something changed, or the pass expired): confirm here rather than reloading. */
function onProceedRefused(reason) {
  _proceedLoading = false;
  _proceedMarkup = "";
  _bounce = PM.bounceReason(reason) || PM.bounceReason("dirty");
  renderProceedGate();
  if (reason === "scanning") {
    setStatus(_bounce.key, _bounce.fallback, null, STATUS);
    return;
  }
  runScans({ auto: true });
}

function wireControls() {
  document.getElementById("btn-rescan")?.addEventListener("click", () => runScans());
  document.getElementById("btn-proceed")?.addEventListener("click", onProceedClick);
  document.getElementById("btn-what-we-check")?.addEventListener("click", toggleExplainer);
  document.getElementById("btn-diagnostics")?.addEventListener("click", onCopyDiagnostics);
  document.getElementById("btn-contact-support")?.addEventListener("click", openSupport);
  document.getElementById("btn-help-support")?.addEventListener("click", openSupport);

  wireDialog();
  watchStickyBars();
}

/** Hairlines on the sticky bars only while content is scrolled under them. */
function watchStickyBars() {
  if (typeof IntersectionObserver !== "function") {
    return;
  }
  const topbar = document.querySelector(".sc-topbar");
  const actionbar = document.querySelector(".sc-actionbar");
  const intro = document.querySelector(".sc-intro");
  const end = document.getElementById("sc-end");
  if (topbar && intro) {
    new IntersectionObserver(([entry]) => {
      topbar.classList.toggle("sc-topbar--raised", entry.boundingClientRect.top < 0);
    }).observe(intro);
  }
  if (actionbar && end) {
    new IntersectionObserver(([entry]) => {
      actionbar.classList.toggle("sc-actionbar--raised", !entry.isIntersecting);
    }).observe(end);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Before any await: the pre-reveal render pass only reaches renderers registered by then.
  window.i18n?.registerRenderer?.(renderI18n);
  wireControls();

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  const api = window.electronAPI;
  if (api?.getAppList) {
    try {
      const appList = await api.getAppList();
      APP_DISPLAY_NAMES = appList?.displayNames || {};
    } catch (e) {
      console.error("[preflight] failed to load app list", e);
    }
  }

  api
    ?.getAppVersion?.()
    .then((v) => {
      _appVersion = v || null;
      const el = document.getElementById("app-version");
      if (el && v) {
        el.textContent = `v${v}`;
      }
    })
    .catch(() => {});

  api
    ?.canElevate?.()
    .then((ok) => {
      _canElevate = ok === true;
    })
    .catch(() => {
      _canElevate = false;
    });

  api
    ?.getSupportInfo?.()
    .then((info) => {
      _supportAvailable = info?.available === true;
      renderSupport();
    })
    .catch(() => {});

  api?.onPreProceedStatus?.(onLiveStatus);

  runScans();
});
