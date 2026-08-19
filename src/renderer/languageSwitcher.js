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

    window.addEventListener("i18n:changed", () => {
      select.setAttribute("aria-label", window.t ? window.t("langSwitcher.label") : "Language");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
