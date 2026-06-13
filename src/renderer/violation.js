/**
 * src/renderer/violation.js
 * ─────────────────────────
 * Violation page controller.
 * Reads the violation reason from the URL query string and
 * renders contextual help text based on the violation type.
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("reason") || "Unauthorized activity detected.";

  document.getElementById("violation-reason").textContent = reason;

  // ── Contextual Help Text ────────────────────────────────────────────────

  const helpEl = document.getElementById("violation-help");
  const rLower = reason.toLowerCase();

  if (
    rLower.includes("monitor") ||
    rLower.includes("hdmi") ||
    rLower.includes("display") ||
    rLower.includes("resolution")
  ) {
    helpEl.textContent =
      "Please disconnect any external displays, HDMI cables, or docking stations before re-checking.";
  } else if (
    rLower.includes("mirroring") ||
    rLower.includes("casting") ||
    rLower.includes("apps")
  ) {
    helpEl.textContent =
      "Please completely close all screen sharing, meeting, or browser applications (e.g., Zoom, Teams, Chrome) before re-checking.";
  } else if (
    rLower.includes("focus") ||
    rLower.includes("minimize") ||
    rLower.includes("tab")
  ) {
    helpEl.textContent =
      "Please ensure the interview window remains in focus and full-screen at all times. Do not minimize or switch windows.";
  } else {
    helpEl.textContent =
      "Please resolve the security issue and ensure all unauthorized apps are closed before re-checking.";
  }

  // ── Button Handlers ─────────────────────────────────────────────────────

  document.getElementById("btn-quit").addEventListener("click", () => {
    window.electronAPI?.quitApp();
  });

  document.getElementById("btn-recheck").addEventListener("click", () => {
    const btn = document.getElementById("btn-recheck");
    btn.textContent = "Checking...";
    btn.disabled = true;
    btn.classList.add("opacity-50", "cursor-not-allowed");
    window.electronAPI?.recheckSystem();
  });
});
