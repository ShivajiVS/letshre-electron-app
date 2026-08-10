/**
 * assets/js/i18n.js
 * ──────────────────
 * Renderer-side i18n runtime. Loaded by every native page (before its own
 * controller script). Reads the active locale + translation bundle from the
 * main process over window.electronAPI (see preload.js / localeManager.js),
 * applies it to the DOM, and exposes window.t() for dynamic strings built in
 * renderer JS.
 *
 * No-FOUC: pages start with <html class="i18n-pending"> and
 * `html.i18n-pending body { visibility: hidden }` in i18n.css. This script
 * removes the class once translations are applied.
 */

/* eslint-env browser */
"use strict";

(function () {
  let _bundle = {};
  let _locale = "en";

  /** Resolves a dot-path key against the flat-nested bundle, e.g. "login.title". */
  function _lookup(key) {
    const parts = key.split(".");
    let node = _bundle;
    for (const part of parts) {
      if (node === null || node === undefined || typeof node !== "object") {return undefined;}
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  }

  /** Interpolates {token} placeholders in a string with values from params. */
  function _interpolate(str, params) {
    if (!params) {return str;}
    return str.replace(/\{(\w+)\}/g, (match, token) =>
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
    );
  }

  /**
   * Translate a key. Falls back to the raw key (visibly broken, easy to spot
   * in QA) if missing — the main process already falls back bundle-to-bundle
   * (requested locale -> en), so a missing key here means it's absent even
   * from English.
   * @param {string} key
   * @param {object} [params]
   */
  function t(key, params) {
    const value = _lookup(key);
    if (value === undefined) {
      if (window.electronAPI) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing key: ${key}`);
      }
      return key;
    }
    return _interpolate(value, params);
  }

  function _applyToDOM() {
    document.documentElement.lang = _locale;
    const dir = _bundle?._meta?.dir === "rtl" ? "rtl" : "ltr";
    document.documentElement.dir = dir;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) {el.textContent = t(key);}
    });

    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      // format: data-i18n-attr="placeholder:key.a|aria-label:key.b"
      const spec = el.getAttribute("data-i18n-attr");
      spec.split("|").forEach((pair) => {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        if (attr && key) {el.setAttribute(attr, t(key));}
      });
    });

    document.documentElement.classList.remove("i18n-pending");
  }

  // Resolved once the first bundle load (or the outside-Electron no-op) has
  // completed. languageSwitcher.js (and anything else that calls window.t()
  // on load) must await this before rendering — otherwise it reads against
  // the empty default bundle and logs spurious "missing key" warnings.
  let _resolveReady;
  const readyPromise = new Promise((resolve) => { _resolveReady = resolve; });

  async function initI18n() {
    if (!window.electronAPI?.getLocale) {
      // Running outside Electron (or preload failed) — reveal page as-is.
      document.documentElement.classList.remove("i18n-pending");
      _resolveReady();
      return;
    }
    try {
      _locale = await window.electronAPI.getLocale();
      _bundle = await window.electronAPI.getTranslations(_locale);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[i18n] failed to load translations, staying in English:", err);
      _bundle = {};
    }
    _applyToDOM();
    _resolveReady();

    // Live update if the locale changes from the switcher without a reload.
    window.electronAPI.onLocaleChanged?.(async (newLocale) => {
      _locale = newLocale;
      _bundle = await window.electronAPI.getTranslations(newLocale);
      _applyToDOM();
      window.dispatchEvent(new CustomEvent("i18n:changed", { detail: { locale: newLocale } }));
    });
  }

  function getLocale() {
    return _locale;
  }

  window.t = t;
  window.i18n = { initI18n, getLocale, ready: readyPromise };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
  } else {
    initI18n();
  }
})();
