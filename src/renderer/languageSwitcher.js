/**
 * Language dropdown rendered into id="lang-switcher". Include after
 * assets/js/i18n.js.
 */

"use strict";

(function () {
  const GLOBE =
    '<svg class="lang-switcher__globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>';
  const CHEVRON =
    '<svg class="lang-switcher__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const CHECK =
    '<svg class="lang-switcher__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  const label = () => (window.t ? window.t("langSwitcher.label") : "Language");

  async function mount() {
    const container = document.getElementById("lang-switcher");
    if (!container || !window.electronAPI?.getSupportedLocales) {
      return;
    }

    if (window.i18n?.ready) {
      await window.i18n.ready;
    }

    const [locales, initial] = await Promise.all([
      window.electronAPI.getSupportedLocales(),
      window.electronAPI.getLocale(),
    ]);

    // Production is English-only for now, so there is nothing to switch.
    if (locales.length <= 1) {
      container.style.display = "none";
      return;
    }

    let current = initial;
    let active = -1;
    let typed = "";
    let typedTimer = null;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "lang-switcher__trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `${GLOBE}<span class="lang-switcher__value"></span>${CHEVRON}`;
    const valueEl = trigger.querySelector(".lang-switcher__value");

    const list = document.createElement("ul");
    list.className = "lang-switcher__menu";
    list.id = "lang-switcher-menu";
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    list.hidden = true;
    trigger.setAttribute("aria-controls", list.id);

    const options = locales.map(({ code, name, english }) => {
      const li = document.createElement("li");
      li.className = "lang-switcher__option";
      li.id = `lang-opt-${code}`;
      li.dataset.code = code;
      li.setAttribute("role", "option");

      const native = document.createElement("span");
      native.className = "lang-switcher__native";
      native.lang = code;
      native.textContent = name;
      li.appendChild(native);

      if (english && english !== name) {
        const en = document.createElement("span");
        en.className = "lang-switcher__english";
        en.lang = "en";
        en.textContent = english;
        li.appendChild(en);
      }
      li.insertAdjacentHTML("beforeend", CHECK);
      return li;
    });
    list.append(...options);

    function paint() {
      const locale = locales.find((l) => l.code === current) || locales[0];
      valueEl.textContent = locale.name;
      valueEl.lang = locale.code;
      trigger.setAttribute("aria-label", `${label()}: ${locale.english || locale.name}`);
      list.setAttribute("aria-label", label());
      options.forEach((li) =>
        li.setAttribute("aria-selected", String(li.dataset.code === current))
      );
    }

    function setActive(index) {
      options[active]?.classList.remove("is-active");
      active = (index + options.length) % options.length;
      const li = options[active];
      li.classList.add("is-active");
      list.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    }

    function open() {
      if (!list.hidden) {
        return;
      }
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      setActive(
        Math.max(
          0,
          options.findIndex((li) => li.dataset.code === current)
        )
      );
      list.focus();
      document.addEventListener("pointerdown", onOutside, true);
    }

    function close(refocus = true) {
      if (list.hidden) {
        return;
      }
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      if (refocus) {
        trigger.focus();
      }
    }

    function onOutside(e) {
      if (!container.contains(e.target)) {
        close(false);
      }
    }

    async function choose(code) {
      close();
      if (code === current) {
        return;
      }
      current = code;
      paint();
      await window.electronAPI.setLocale(code);
    }

    function typeAhead(char) {
      clearTimeout(typedTimer);
      typed += char.toLowerCase();
      typedTimer = setTimeout(() => (typed = ""), 600);
      const match = locales.findIndex(
        (l) =>
          (l.english || "").toLowerCase().startsWith(typed) ||
          l.name.toLowerCase().startsWith(typed)
      );
      if (match >= 0) {
        setActive(match);
      }
    }

    trigger.addEventListener("click", () => (list.hidden ? open() : close()));
    trigger.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        open();
      }
    });

    list.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowDown":
          setActive(active + 1);
          break;
        case "ArrowUp":
          setActive(active - 1);
          break;
        case "Home":
          setActive(0);
          break;
        case "End":
          setActive(options.length - 1);
          break;
        case "Enter":
        case " ":
          choose(options[active].dataset.code);
          break;
        case "Escape":
          close();
          break;
        case "Tab":
          close(false);
          return;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            typeAhead(e.key);
            break;
          }
          return;
      }
      e.preventDefault();
    });

    list.addEventListener("pointermove", (e) => {
      const li = e.target.closest(".lang-switcher__option");
      if (li && options.indexOf(li) !== active) {
        setActive(options.indexOf(li));
      }
    });
    list.addEventListener("click", (e) => {
      const li = e.target.closest(".lang-switcher__option");
      if (li) {
        choose(li.dataset.code);
      }
    });

    container.innerHTML = "";
    container.classList.add("lang-switcher");
    container.append(trigger, list);
    paint();

    // Main broadcasts locale changes to every window, and the language page
    // can change it too, so follow whatever was actually applied.
    window.addEventListener("i18n:changed", (e) => {
      current = e.detail?.locale || current;
      paint();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
