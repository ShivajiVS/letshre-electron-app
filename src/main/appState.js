/**
=
 * Centralised, type-safe application state.
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
  setQuitting() {
    _isQuitting = true;
  },

  isQuitting() {
    return _isQuitting;
  },
};

module.exports = appState;
