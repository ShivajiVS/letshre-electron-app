/**
 * Renders a keyboard-accessible language dropdown into any element with
 * id="lang-switcher". Include after assets/js/i18n.js on every page that has
 * the container in its markup.
 */

"use strict";

(function () {
  async function mount() {
    const container = document.getElementById("lang-switcher");
    if (!container || !window.electronAPI?.getSupportedLocales) {
      return;
    }

    // Wait for i18n.js to finish loading the active bundle so window.t()
    // below doesn't read against the empty default bundle and warn.
    if (window.i18n?.ready) {
      await window.i18n.ready;
    }

    const [locales, current] = await Promise.all([
      window.electronAPI.getSupportedLocales(),
      window.electronAPI.getLocale(),
    ]);

    // Production gates to English-only until certified translations land
    // (see localeManager.js's `_localeAllowed()`) — a single-option dropdown
    // has nothing to switch between, so hide the switcher entirely rather
    // than render it.
    if (locales.length <= 1) {
      container.style.display = "none";
      return;
    }

    const select = document.createElement("select");
    select.className = "lang-switcher__select";
    select.setAttribute("aria-label", window.t ? window.t("langSwitcher.label") : "Language");

    locales.forEach(({ code, name }) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      if (code === current) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    select.addEventListener("change", async () => {
      await window.electronAPI.setLocale(select.value);
      // i18n.js's own onLocaleChanged listener re-applies translations; this
      // page also re-renders the switcher's own aria-label after that.
    });

    container.innerHTML = "";
    container.appendChild(select);

    window.addEventListener("i18n:changed", (e) => {
      select.setAttribute("aria-label", window.t ? window.t("langSwitcher.label") : "Language");
      // Keep the select's own value in sync — today this only ever fires from
      // this dropdown's own change event, but ipcHandlers.js broadcasts
      // LOCALE_CHANGED to every open window, so a future second window must
      // not leave this one showing a stale selection.
      const newLocale = e.detail?.locale;
      if (newLocale && select.value !== newLocale) {
        select.value = newLocale;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
