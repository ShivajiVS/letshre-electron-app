/**
 * src/renderer/rendererUtils.js
 * ──────────────────────────────
 * Small helpers shared across the renderer pages (dashboard, permissions,
 * identity-verification, role-selection, preflight). Plain browser script —
 * no bundler, no `require`/`module.exports` — attaches to `window` like
 * languageSwitcher.js. Include this AFTER languageSwitcher.js and BEFORE the
 * page's own renderer script.
 */

/* eslint-env browser */
"use strict";

/**
 * Escapes text for safe insertion into the DOM.
 */
window.escHtml = function escHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
};

/**
 * Shared "disable button → do something async → restore after a timeout"
 * watchdog used by every nav button that triggers a page teardown (main
 * navigates elsewhere, which kills this timer along with the rest of the
 * page). If the timer DOES fire, navigation never happened, so the button
 * (and any extra page state via `onRestore`) is restored for a retry.
 *
 * Callers capture the button's original innerHTML themselves BEFORE calling
 * this (they need the pristine markup, captured before mutating the button
 * into its "loading" state), then call this right after starting the async
 * action:
 *
 *   const btnHTML = btn.innerHTML;
 *   btn.disabled = true;
 *   btn.innerHTML = "Starting…";
 *   window.electronAPI.doThing();
 *   window.armButtonRestore(btn, btnHTML, {
 *     onRestore: () => { note.textContent = "That took too long. Please try again."; }
 *   });
 *
 * Returns the timer id (from setTimeout) in case a caller ever needs to
 * clearTimeout it early.
 */
window.armButtonRestore = function armButtonRestore(btn, originalHTML, options) {
  const { timeoutMs = 6000, onRestore } = options || {};
  return setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    if (typeof onRestore === "function") { onRestore(); }
  }, timeoutMs);
};
