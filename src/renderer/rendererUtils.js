/**
 * Small helpers shared across the renderer pages (dashboard, permissions,
 * identity-verification, role-selection, preflight). Plain browser script —
 * no bundler, no `require`/`module.exports` — attaches to `window` like
 * languageSwitcher.js. Include this AFTER languageSwitcher.js and BEFORE the
 * page's own renderer script.
 */

/* eslint-env browser */
"use strict";

window.escHtml = function escHtml(str) {
  return String(str || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
};

/**
 * Watchdog for "disable button → kick off async nav → restore on timeout".
 * A successful navigation tears down the page (and this timer with it), so if
 * the timer DOES fire, nav never happened — restore the button for a retry.
 *
 * Callers must grab the button's original innerHTML themselves before
 * mutating it into a loading state, then call this right after starting the
 * async action:
 *
 *   const btnHTML = btn.innerHTML;
 *   btn.disabled = true;
 *   btn.innerHTML = "Starting…";
 *   window.electronAPI.doThing();
 *   window.armButtonRestore(btn, btnHTML, {
 *     onRestore: () => { note.textContent = "That took too long. Please try again."; }
 *   });
 *
 * Returns the setTimeout id in case a caller wants to clearTimeout it early.
 */
window.armButtonRestore = function armButtonRestore(btn, originalHTML, options) {
  const { timeoutMs = 6000, onRestore } = options || {};
  return setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    if (typeof onRestore === "function") {
      onRestore();
    }
  }, timeoutMs);
};
