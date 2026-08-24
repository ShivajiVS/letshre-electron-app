/**
 * Requests camera, microphone, and screen-sharing access independently via
 * the Web API. Each card has its own state machine:
 *   idle → requesting → granted | denied
 *
 * Tracks are stopped immediately after grant (permission is all we need).
 * Screen sharing auto-grants via Electron's setDisplayMediaRequestHandler.
 * The Start Interview button unlocks only when all three reach "granted".
 */

"use strict";

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = { camera: "idle", mic: "idle", screen: "idle" };

  const ICON = {
    camera: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    mic: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    screen: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  };

  // Animated checkmark: stroke-dashoffset draws in via CSS .perm-check-path
  const CHECK_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path class="perm-check-path" d="M20 6L9 17l-5-5"/></svg>`;

  const CROSS_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const SPIN_SVG = `<svg class="perm-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>`;

  // ── Badge config
  function badgeFor(newState) {
    switch (newState) {
      case "requesting":
        return {
          text: tr("perm.requesting", "Requesting…"),
          cls: "perm-badge perm-badge--pending",
        };
      case "granted":
        return { text: tr("perm.allowed", "✓ Allowed"), cls: "perm-badge perm-badge--granted" };
      case "denied":
        return { text: tr("perm.denied", "✗ Denied"), cls: "perm-badge perm-badge--denied" };
      default:
        return { text: tr("common.required", "Required"), cls: "perm-badge" };
    }
  }

  const BTN_LABEL_KEY = {
    camera: ["perm.allowCamera", "Allow camera"],
    mic: ["perm.allowMic", "Allow microphone"],
    screen: ["perm.allowScreen", "Allow screen"],
  };

  // ── Apply state
  function applyState(perm, newState) {
    state[perm] = newState;

    const card = document.getElementById(`card-${perm}`);
    const icon = document.getElementById(`icon-${perm}`);
    const badge = document.getElementById(`badge-${perm}`);
    const btn = document.getElementById(`btn-${perm}`);

    // Card modifier — preserve base class
    card.className = `perm-card${newState !== "idle" ? ` perm-card--${newState}` : ""}`;

    if (newState === "requesting") {
      icon.innerHTML = SPIN_SVG;
    } else if (newState === "granted") {
      icon.innerHTML = CHECK_SVG;
    } else if (newState === "denied") {
      icon.innerHTML = CROSS_SVG;
    } else {
      icon.innerHTML = ICON[perm];
    }

    const badgeState = badgeFor(newState);
    badge.textContent = badgeState.text;
    badge.className = badgeState.cls;

    if (newState === "granted") {
      btn.style.display = "none";
    } else if (newState === "denied") {
      btn.style.display = "";
      btn.disabled = false;
      btn.textContent = tr("perm.tryAgain", "Try again");
    } else {
      btn.style.display = "";
      btn.disabled = newState === "requesting";
      const [key, fallback] = BTN_LABEL_KEY[perm];
      btn.textContent = tr(key, fallback);
    }

    syncStartButton();
  }

  // ── Start button gate
  const btnStart = document.getElementById("btn-start");
  const permNote = document.getElementById("perm-note");

  // The note under the Start button has more sources than "are all perms
  // granted": a deny hint, an unavailable-bridge message, or a watchdog
  // timeout can each overwrite it after the fact. renderI18n() needs to know
  // which one is currently showing to reproduce it (not the generic note) in
  // the new language, so every write goes through setNoteState().
  let noteState = { kind: "sync" };
  let startState = "idle"; // "idle" | "starting" — drives the Start button label

  function renderNote() {
    switch (noteState.kind) {
      case "hint":
        permNote.textContent = permissionErrorHint(noteState.perm, noteState.errName);
        permNote.classList.remove("all-granted");
        break;
      case "unavailable":
        permNote.textContent = tr(
          "perm.startUnavailable",
          "Unable to continue — please restart the app."
        );
        permNote.classList.remove("all-granted");
        break;
      case "timedOut":
        permNote.textContent = tr("perm.startTimedOut", "That took too long. Please try again.");
        permNote.classList.remove("all-granted");
        break;
      default: {
        const allGranted = Object.values(state).every((s) => s === "granted");
        permNote.textContent = allGranted
          ? tr("perm.allGranted", "All permissions granted — you're ready to begin.")
          : tr("perm.continueNote", "Allow all three permissions above to continue.");
        permNote.classList.toggle("all-granted", allGranted);
      }
    }
  }

  function setNoteState(next) {
    noteState = next;
    renderNote();
  }

  function syncStartButton() {
    const allGranted = Object.values(state).every((s) => s === "granted");
    btnStart.disabled = !allGranted;
    setNoteState({ kind: "sync" });
  }

  function renderStartButtonLabel() {
    const label = document.getElementById("btn-start-label");
    if (!label) {
      return;
    }
    label.textContent =
      startState === "starting"
        ? tr("perm.starting", "Starting…")
        : tr("common.continue", "Continue");
  }

  // ── Permission requests
  // Map a getUserMedia rejection to actionable guidance. A plain "Try again" is
  // a dead-end when the block is permanent (OS-level denial) or the device is
  // missing / busy — the user needs to know WHAT to do before retrying.
  const PERM_NAME_KEY = {
    camera: ["perm.cameraName", "Camera"],
    mic: ["perm.micName", "Microphone"],
    screen: ["perm.screenName", "Screen sharing"],
  };
  function permissionErrorHint(perm, errName) {
    const [nameKey, nameFallback] = PERM_NAME_KEY[perm];
    const label = tr(nameKey, nameFallback);
    if (errName === "NotAllowedError" || errName === "SecurityError") {
      return tr(
        "perm.errorBlocked",
        "{label} access is blocked. Enable it in your system Settings › Privacy, then click Try again.",
        { label }
      );
    }
    if (errName === "NotFoundError" || errName === "OverconstrainedError") {
      return tr(
        "perm.errorNoDevice",
        "No {label} device was found. Connect one and click Try again.",
        {
          label,
        }
      );
    }
    if (errName === "NotReadableError" || errName === "AbortError") {
      return tr(
        "perm.errorInUse",
        "Your {label} is in use by another app. Close it and click Try again.",
        { label }
      );
    }
    return tr("perm.errorGeneric", "Could not access {label}. Please click Try again.", { label });
  }

  // applyState(...) ends by calling syncStartButton(), which resets the note to
  // "sync" — so the hint must be set AFTER applyState to win.
  function denyWithHint(perm, err) {
    applyState(perm, "denied");
    setNoteState({ kind: "hint", perm, errName: err?.name });
  }

  // ── i18n render hook — re-derives every tr()-rendered string from current
  // state. Registered synchronously below, ahead of the readiness wait, so
  // it runs as part of the pre-reveal pass and the page never paints
  // English defaults for a non-English locale.
  function renderI18n() {
    ["camera", "mic", "screen"].forEach((perm) => {
      const badge = document.getElementById(`badge-${perm}`);
      const btn = document.getElementById(`btn-${perm}`);
      badge.textContent = badgeFor(state[perm]).text;
      if (state[perm] === "denied") {
        btn.textContent = tr("perm.tryAgain", "Try again");
      } else if (state[perm] !== "granted") {
        const [key, fallback] = BTN_LABEL_KEY[perm];
        btn.textContent = tr(key, fallback);
      }
    });
    renderStartButtonLabel();
    renderNote();
  }
  window.i18n?.registerRenderer(renderI18n);

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  async function requestCamera() {
    applyState("camera", "requesting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      applyState("camera", "granted");
    } catch (err) {
      denyWithHint("camera", err);
    }
  }

  async function requestMic() {
    applyState("mic", "requesting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      applyState("mic", "granted");
    } catch (err) {
      denyWithHint("mic", err);
    }
  }

  async function requestScreen() {
    applyState("screen", "requesting");
    try {
      // Electron's setDisplayMediaRequestHandler auto-selects screen 0;
      // no OS picker dialog appears.
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      applyState("screen", "granted");
    } catch (err) {
      denyWithHint("screen", err);
    }
  }

  // ── Wire buttons ────────────────────────────────────────────────────────
  document.getElementById("btn-camera").addEventListener("click", requestCamera);
  document.getElementById("btn-mic").addEventListener("click", requestMic);
  document.getElementById("btn-screen").addEventListener("click", requestScreen);

  const startBtnHTML = btnStart.innerHTML; // capture original for restore
  btnStart.addEventListener("click", () => {
    if (btnStart.disabled) {
      return;
    }
    // Fail loud if the bridge method is missing — never spin forever silently.
    if (typeof window.electronAPI?.loadIdentityVerification !== "function") {
      setNoteState({ kind: "unavailable" });
      return;
    }
    btnStart.disabled = true;
    startState = "starting";
    // Query fresh nodes (restore below replaces these by innerHTML).
    renderStartButtonLabel();
    document.getElementById("btn-start-icon").outerHTML =
      `<svg class="perm-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>`;
    window.electronAPI.loadIdentityVerification();
    // Watchdog: successful navigation tears down this page. If this fires,
    // navigation never happened — restore the button so the user can retry.
    window.armButtonRestore(btnStart, startBtnHTML, {
      onRestore: () => {
        startState = "idle";
        setNoteState({ kind: "timedOut" });
        // The restored innerHTML is a snapshot from page load; re-run in case
        // the locale changed since then so the button isn't left stale.
        renderStartButtonLabel();
      },
    });
  });
});
