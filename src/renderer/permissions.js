/**
 * src/renderer/permissions.js
 * ───────────────────────────
 * Permissions page controller.
 *
 * Requests camera, microphone, and screen-sharing access independently via
 * the Web API. Each card has its own state machine:
 *   idle → requesting → granted | denied
 *
 * Tracks are stopped immediately after grant (permission is all we need).
 * Screen sharing auto-grants via Electron's setDisplayMediaRequestHandler.
 * The Start Interview button unlocks only when all three reach "granted".
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {

  // ── State ───────────────────────────────────────────────────────────────
  const state = { camera: "idle", mic: "idle", screen: "idle" };

  // ── SVG templates ───────────────────────────────────────────────────────
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

  // X for denied
  const CROSS_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  // Spinner for requesting state
  const SPIN_SVG = `<svg class="perm-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>`;

  // ── Badge config ────────────────────────────────────────────────────────
  const BADGE = {
    idle:       { text: "Required",     cls: "perm-badge" },
    requesting: { text: "Requesting…",  cls: "perm-badge perm-badge--pending" },
    granted:    { text: "✓ Allowed",    cls: "perm-badge perm-badge--granted" },
    denied:     { text: "✗ Denied",     cls: "perm-badge perm-badge--denied" },
  };

  const BTN_LABEL = { camera: "Allow camera", mic: "Allow microphone", screen: "Allow screen" };

  // ── Apply state ─────────────────────────────────────────────────────────
  function applyState(perm, newState) {
    state[perm] = newState;

    const card  = document.getElementById(`card-${perm}`);
    const icon  = document.getElementById(`icon-${perm}`);
    const badge = document.getElementById(`badge-${perm}`);
    const btn   = document.getElementById(`btn-${perm}`);

    // Card modifier — preserve base class
    card.className = `perm-card${newState !== "idle" ? ` perm-card--${newState}` : ""}`;

    // Icon content
    if (newState === "requesting") {
      icon.innerHTML = SPIN_SVG;
    } else if (newState === "granted") {
      icon.innerHTML = CHECK_SVG;
    } else if (newState === "denied") {
      icon.innerHTML = CROSS_SVG;
    } else {
      icon.innerHTML = ICON[perm];
    }

    // Badge
    badge.textContent = BADGE[newState].text;
    badge.className   = BADGE[newState].cls;

    // Allow / retry button
    if (newState === "granted") {
      btn.style.display = "none";
    } else if (newState === "denied") {
      btn.style.display = "";
      btn.disabled      = false;
      btn.textContent   = "Try again";
    } else {
      btn.style.display = "";
      btn.disabled      = newState === "requesting";
      btn.textContent   = BTN_LABEL[perm];
    }

    syncStartButton();
  }

  // ── Start button gate ───────────────────────────────────────────────────
  const btnStart   = document.getElementById("btn-start");
  const btnLabel   = document.getElementById("btn-start-label");
  const btnIcon    = document.getElementById("btn-start-icon");
  const permNote   = document.getElementById("perm-note");

  function syncStartButton() {
    const allGranted = Object.values(state).every(s => s === "granted");
    btnStart.disabled = !allGranted;
    permNote.textContent = allGranted
      ? "All permissions granted — you're ready to begin."
      : "Allow all three permissions above to continue.";
    permNote.classList.toggle("all-granted", allGranted);
  }

  // ── Permission requests ─────────────────────────────────────────────────
  async function requestCamera() {
    applyState("camera", "requesting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
      applyState("camera", "granted");
    } catch {
      applyState("camera", "denied");
    }
  }

  async function requestMic() {
    applyState("mic", "requesting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      applyState("mic", "granted");
    } catch {
      applyState("mic", "denied");
    }
  }

  async function requestScreen() {
    applyState("screen", "requesting");
    try {
      // Electron's setDisplayMediaRequestHandler auto-selects screen 0;
      // no OS picker dialog appears.
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      s.getTracks().forEach(t => t.stop());
      applyState("screen", "granted");
    } catch {
      applyState("screen", "denied");
    }
  }

  // ── Wire buttons ────────────────────────────────────────────────────────
  document.getElementById("btn-camera").addEventListener("click", requestCamera);
  document.getElementById("btn-mic").addEventListener("click", requestMic);
  document.getElementById("btn-screen").addEventListener("click", requestScreen);

  btnStart.addEventListener("click", () => {
    if (btnStart.disabled) { return; }
    btnStart.disabled = true;
    btnLabel.textContent = "Starting…";
    btnIcon.outerHTML = `<svg class="perm-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>`;
    window.electronAPI?.loadIdentityVerification?.();
  });
});
