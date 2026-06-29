/**
 * src/renderer/permissions.js
 * ───────────────────────────
 * Permissions page controller.
 *
 * Requests camera, microphone, and screen-sharing access via the standard
 * Web APIs. Each permission is requested independently so the user sees
 * clear per-item feedback. The "Start Interview" button unlocks only when
 * all three are granted.
 *
 * On grant  → tracks are stopped immediately (we only needed the permission,
 *             not the live stream).
 * On denial → card shows a "Try again" button so the user can fix OS
 *             settings and retry without leaving the page.
 *
 * Screen sharing: Electron's setDisplayMediaRequestHandler (already wired in
 * app.js) auto-selects screen 0 — no OS picker dialog appears. The card
 * still shows so the candidate knows their screen will be shared.
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  // ── State ───────────────────────────────────────────────────────────────
  const state = { camera: "idle", mic: "idle", screen: "idle" };

  // ── Element refs ────────────────────────────────────────────────────────
  const btnStart  = document.getElementById("btn-start");
  const permNote  = document.getElementById("perm-note");

  // ── Badge config ────────────────────────────────────────────────────────
  const BADGE = {
    idle:       { text: "Required",     cls: "perm-badge" },
    requesting: { text: "Requesting…",  cls: "perm-badge perm-badge--pending" },
    granted:    { text: "✓ Allowed",    cls: "perm-badge perm-badge--granted" },
    denied:     { text: "✗ Denied",     cls: "perm-badge perm-badge--denied" },
  };

  // SVG icon for each permission (used to swap to checkmark/spinner on state change)
  const ICON_SVG = {
    camera: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    mic: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    screen: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  };

  const CHECK_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6L9 17l-5-5"/></svg>`;

  const SPIN_SVG = `<svg class="perm-spinning" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

  // ── Apply state to a card ───────────────────────────────────────────────
  function applyState(perm, newState) {
    state[perm] = newState;

    const card  = document.getElementById(`card-${perm}`);
    const icon  = document.getElementById(`icon-${perm}`);
    const badge = document.getElementById(`badge-${perm}`);
    const btn   = document.getElementById(`btn-${perm}`);

    // Card modifier class
    card.className = `perm-card${newState !== "idle" ? ` perm-card--${newState}` : ""}`;

    // Icon: spinner while requesting, checkmark when granted, original on idle/denied
    if (newState === "requesting") {
      icon.innerHTML = SPIN_SVG;
    } else if (newState === "granted") {
      icon.innerHTML = CHECK_SVG;
    } else {
      icon.innerHTML = ICON_SVG[perm];
    }

    // Badge
    const { text, cls } = BADGE[newState];
    badge.textContent = text;
    badge.className   = cls;

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
      btn.textContent   = { camera: "Allow camera", mic: "Allow microphone", screen: "Allow screen" }[perm];
    }

    syncStartButton();
  }

  // ── Gate the Start button ───────────────────────────────────────────────
  function syncStartButton() {
    const allGranted = Object.values(state).every(s => s === "granted");
    btnStart.disabled = !allGranted;
    if (allGranted) {
      permNote.textContent = "All permissions granted. You're ready to begin.";
      permNote.classList.add("all-granted");
    } else {
      permNote.textContent = "Allow all three permissions above to continue.";
      permNote.classList.remove("all-granted");
    }
  }

  // ── Permission requests ─────────────────────────────────────────────────
  async function requestCamera() {
    applyState("camera", "requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      applyState("camera", "granted");
    } catch {
      applyState("camera", "denied");
    }
  }

  async function requestMic() {
    applyState("mic", "requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      applyState("mic", "granted");
    } catch {
      applyState("mic", "denied");
    }
  }

  async function requestScreen() {
    applyState("screen", "requesting");
    try {
      // Electron's setDisplayMediaRequestHandler auto-selects screen 0 —
      // no OS picker appears. We just verify the call succeeds.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
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
    btnStart.innerHTML = `${SPIN_SVG} Starting…`;
    window.electronAPI?.proceedToInterview?.();
  });
});
