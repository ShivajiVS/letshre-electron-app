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

  /**
   * Resolves ICU-lite plural blocks: {key, plural, one {# thing} other {# things}}.
   * `#` inside a branch is replaced with the count. Falls back to the "other"
   * branch if the locale's CLDR category (via Intl.PluralRules) has no branch
   * of its own — so a string only needs to define the categories that
   * actually differ, not all six. Branch bodies are plain text + `#` only, no
   * nested {tokens} — every current use case only needs that.
   */
  function _pluralize(str, params, locale) {
    if (!params) {return str;}
    let out = "";
    let cursor = 0;
    const OPEN = /\{(\w+),\s*plural,\s*/g;
    let match;
    while ((match = OPEN.exec(str))) {
      const key = match[1];
      let depth = 1;
      let i = OPEN.lastIndex;
      while (i < str.length && depth > 0) {
        if (str[i] === "{") {depth++;}
        else if (str[i] === "}") {depth--;}
        i++;
      }
      if (depth !== 0) {break;} // unbalanced braces — leave the rest untouched

      out += str.slice(cursor, match.index);
      const branches = str.slice(OPEN.lastIndex, i - 1);
      const value = Number(params[key]);
      let category = "other";
      try {
        category = new Intl.PluralRules(locale).select(value);
      } catch {
        /* unsupported locale tag — "other" already covers every string */
      }
      let chosen;
      let fallback;
      const BRANCH = /(\w+)\s*\{([^{}]*)\}/g;
      let branchMatch;
      while ((branchMatch = BRANCH.exec(branches))) {
        if (branchMatch[1] === category) {chosen = branchMatch[2];}
        if (branchMatch[1] === "other") {fallback = branchMatch[2];}
      }
      out += (chosen ?? fallback ?? "").replace(/#/g, String(value));

      cursor = i;
      OPEN.lastIndex = i;
    }
    return out + str.slice(cursor);
  }

  /** Interpolates {token} placeholders (and {key, plural, ...} blocks) with values from params. */
  function _interpolate(str, params, locale) {
    if (!params) {return str;}
    const withPlurals = _pluralize(str, params, locale);
    return withPlurals.replace(/\{(\w+)\}/g, (match, token) =>
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
    return _interpolate(value, params, _locale);
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
  }

  // Page controllers own every string they render through window.t(); the
  // [data-i18n] sweep above cannot reach those (and must not fight the
  // controller for the same element). Each page registers one renderer that
  // re-derives its own text from current state — run once before the page is
  // revealed, and again after every locale change so a mid-session switch
  // re-translates JS-rendered text instead of leaving it in the old language.
  let _bundleLoaded = false;
  const _renderers = new Set();

  /**
   * @param {() => void} fn Re-renders every window.t()-derived string on the
   *   page from current state. Must be idempotent — it is called repeatedly.
   */
  function registerRenderer(fn) {
    if (typeof fn !== "function") {return;}
    _renderers.add(fn);
    // Registered after the bundle landed (late script, or a page that awaited
    // i18n.ready first) — run it now so it never misses the initial pass.
    if (_bundleLoaded) {_safeRender(fn);}
  }

  function _safeRender(fn) {
    try {
      fn();
    } catch (err) {
      // One page's broken renderer must not block the reveal below and leave
      // the whole window stuck at visibility:hidden.
      // eslint-disable-next-line no-console
      console.warn("[i18n] renderer threw:", err);
    }
  }

  function _runRenderers() {
    _bundleLoaded = true;
    _renderers.forEach(_safeRender);
  }

  function _reveal() {
    document.documentElement.classList.remove("i18n-pending");
  }

  // Resolved once the first bundle load (or the outside-Electron no-op) has
  // completed. languageSwitcher.js (and anything else that calls window.t()
  // on load) must await this before rendering — otherwise it reads against
  // the empty default bundle and logs spurious "missing key" warnings.
  let _resolveReady;
  const readyPromise = new Promise((resolve) => { _resolveReady = resolve; });

  async function initI18n() {
    if (!window.electronAPI?.getI18nBootstrap) {
      // Running outside Electron (or preload failed) — reveal page as-is.
      _runRenderers();
      _reveal();
      _resolveReady();
      return;
    }
    try {
      const { locale, bundle } = await window.electronAPI.getI18nBootstrap();
      _locale = locale;
      _bundle = bundle;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[i18n] failed to load translations, staying in English:", err);
      _bundle = {};
    }
    _applyToDOM();
    // Before _reveal(), so JS-owned text is already translated on first paint.
    _runRenderers();
    _reveal();
    _resolveReady();

    // Live update if the locale changes from the switcher without a reload.
    window.electronAPI.onLocaleChanged?.(async (newLocale) => {
      _locale = newLocale;
      _bundle = await window.electronAPI.getTranslations(newLocale);
      _applyToDOM();
      _runRenderers();
      window.dispatchEvent(new CustomEvent("i18n:changed", { detail: { locale: newLocale } }));
    });
  }

  function getLocale() {
    return _locale;
  }

  if (typeof window === "undefined") {
    // Loaded under Node (tests) rather than a browser — export the pure,
    // DOM-free functions instead of wiring up window/document globals.
    // eslint-disable-next-line no-undef
    module.exports = { _pluralize, _interpolate, _lookup };
    return;
  }

  window.t = t;
  window.i18n = { initI18n, getLocale, registerRenderer, ready: readyPromise };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
  } else {
    initI18n();
  }
})();
