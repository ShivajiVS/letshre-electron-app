/**
 * src/main/appState.js
 * ────────────────────
 * Centralised, type-safe application state.
 *
 * Replaces the ad-hoc `app.isQuiting` (misspelled) pattern where a
 * custom property was bolted onto the Electron app object — not
 * type-safe, not declared anywhere, and invisible to other modules.
 *
 * Usage:
 *   const appState = require('./appState');
 *   appState.setQuitting();
 *   if (appState.isQuitting()) { ... }
 */

"use strict";

let _isQuitting = false;

const appState = {
  /** Mark the application as in the process of quitting. */
  setQuitting() {
    _isQuitting = true;
  },

  /** Returns true if app.quit() has been initiated. */
  isQuitting() {
    return _isQuitting;
  },
};

module.exports = appState;
