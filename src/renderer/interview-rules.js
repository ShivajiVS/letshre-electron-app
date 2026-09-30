/**
 * The last setup step: the proctoring rules, with the limits the interview site
 * publishes, and Start Interview. Main hands the site what was accepted.
 */

"use strict";

function tr(key, fallback, params) {
  if (window.t) {
    return window.t(key, params);
  }
  if (!params) {
    return fallback;
  }
  return fallback.replace(/\{(\w+)\}/g, (match, token) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
  );
}

const SPINNER = `<span class="rs-spinner"></span>`;

const LIMIT_LINES = [
  [
    "rules.limits.strikes",
    "After {max} strikes the interview ends and your answers are submitted.",
    (r) => ({ max: r.strikes }),
  ],
  [
    "rules.limits.held",
    "A device left in view, or a camera left off, costs another strike every {seconds} seconds.",
    (r) => ({ seconds: r.heldSeconds }),
  ],
  [
    "rules.limits.face",
    "If your face doesn't match your photo {inARow} times in a row, or {total} times in all, the interview ends.",
    (r) => ({ inARow: r.faceInARow, total: r.faceTotal }),
  ],
  [
    "rules.limits.network",
    "If your internet drops {max} times, the interview is submitted. Drops are not strikes.",
    (r) => ({ max: r.disconnects }),
  ],
];

document.addEventListener("DOMContentLoaded", async () => {
  const limitsList = document.getElementById("ir-limits-list");
  const limitsNote = document.getElementById("ir-limits-note");
  const agree = document.getElementById("ir-agree");
  const btnStart = document.getElementById("btn-start-interview");
  const rsError = document.getElementById("rs-error");
  const rsErrorText = document.getElementById("rs-error-text");

  // undefined while loading, null when the site's limits couldn't be read.
  let rules;
  let isStarting = false;
  let errorState = null;

  function renderLimits() {
    limitsList.replaceChildren();
    limitsList.hidden = !rules;
    limitsNote.hidden = !!rules;
    if (rules === undefined) {
      limitsNote.textContent = tr("rules.loading", "Loading the limits…");
      return;
    }
    if (!rules) {
      limitsNote.textContent = tr(
        "rules.limitsLater",
        "The exact limits will be shown when the interview opens."
      );
      return;
    }
    for (const [key, fallback, params] of LIMIT_LINES) {
      const li = document.createElement("li");
      li.textContent = tr(key, fallback, params(rules));
      limitsList.appendChild(li);
    }
  }

  function syncStart() {
    btnStart.disabled = isStarting || rules === undefined || !agree.checked;
  }

  function renderI18n() {
    renderLimits();
    btnStart.innerHTML = isStarting
      ? `${SPINNER} ${tr("rules.starting", "Starting…")}`
      : tr("rules.start", "Start Interview");
    if (errorState) {
      rsErrorText.textContent = tr(errorState.key, errorState.fallback);
    }
  }

  function showError(key, fallback) {
    errorState = { key, fallback };
    rsErrorText.textContent = tr(key, fallback);
    rsError.hidden = false;
  }

  function hideError() {
    errorState = null;
    rsError.hidden = true;
  }

  window.i18n?.registerRenderer?.(renderI18n);
  if (window.i18n?.ready) {
    await window.i18n.ready;
  }
  renderI18n();
  syncStart();

  agree.addEventListener("change", syncStart);

  btnStart.addEventListener("click", async () => {
    if (btnStart.disabled) {
      return;
    }
    if (typeof window.electronAPI?.proceedToInterview !== "function") {
      showError("rules.startUnavailable", "Unable to start the interview. Please restart the app.");
      return;
    }
    // Main still gates the step; this just saves a round trip it would refuse.
    if (window.securityGuard?.isBlocked()) {
      window.securityGuard.show();
      return;
    }
    hideError();
    const idleHTML = btnStart.innerHTML;
    isStarting = true;
    syncStart();
    renderI18n();
    // Navigation tears this page down; if it never happens, give the button back.
    const watchdog = window.armButtonRestore(btnStart, idleHTML, {
      onRestore: () => {
        isStarting = false;
        syncStart();
        renderI18n();
        showError("role.startTimedOut", "That took too long. Please try again.");
      },
    });
    let res;
    try {
      res = await window.electronAPI.proceedToInterview({ rulesAccepted: agree.checked });
    } catch {
      res = { ok: false };
    }
    // busy: the first click's gate is still running. failed: main is navigating.
    if (res?.ok !== false || res.reason === "busy" || res.reason === "failed") {
      return;
    }
    clearTimeout(watchdog);
    isStarting = false;
    syncStart();
    renderI18n();
    if (!window.securityGuard?.handleRefusal(res)) {
      showError("rules.startUnavailable", "Unable to start the interview. Please restart the app.");
    }
  });

  try {
    const res = await window.electronAPI?.getInterviewRules?.();
    rules = res?.ok ? res.rules : null;
  } catch {
    rules = null;
  }
  renderLimits();
  syncStart();
});
