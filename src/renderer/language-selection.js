/**
 * Language selection controller. Sits between the dashboard and the security
 * check so the candidate picks a language before anything else starts.
 *
 * Main only routes here when more than one locale is selectable, so this file
 * never has to handle the empty/single-option case.
 */

/* eslint-env browser */
"use strict";

// No tr() helper here: every string on this page is static and carries
// data-i18n, and the locale names are endonyms that are never translated.

document.addEventListener("DOMContentLoaded", async () => {
  const optionsEl = document.getElementById("ls-options");
  const btnContinue = document.getElementById("btn-continue");

  /** @type {HTMLElement[]} */
  const cards = [];
  let selected = null;

  function paintSelection() {
    cards.forEach((card) => {
      const isSelected = card.dataset.code === selected;
      card.classList.toggle("ls-option--selected", isSelected);
      card.setAttribute("aria-checked", String(isSelected));
      // Roving tabindex: the group is one tab stop, arrows move within it.
      card.tabIndex = isSelected ? 0 : -1;
    });
  }

  // Registered before the first await so the initial pre-reveal pass includes
  // this page. It is also the sync point with the topbar dropdown: a change
  // from either control lands here, and re-reading the applied locale means a
  // rejected/fallen-back choice corrects itself rather than showing a lie.
  function renderI18n() {
    selected = window.i18n?.getLocale?.() || selected;
    paintSelection();
  }
  window.i18n?.registerRenderer?.(renderI18n);

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  const locales = (await window.electronAPI?.getSupportedLocales?.()) || [];
  selected = window.i18n?.getLocale?.() || locales[0]?.code;

  async function choose(code) {
    if (code === selected) {
      return;
    }
    selected = code;
    paintSelection();
    // Apply immediately so the page itself redraws in the chosen language —
    // the same thing the topbar dropdown does, and the only honest preview of
    // what the candidate is picking.
    await window.electronAPI?.setLocale?.(code);
  }

  function focusCardAt(index) {
    const next = cards[(index + cards.length) % cards.length];
    next.focus();
    choose(next.dataset.code);
  }

  locales.forEach((locale, i) => {
    const card = document.createElement("div");
    card.className = "ls-option";
    card.dataset.code = locale.code;
    card.setAttribute("role", "radio");
    card.style.animationDelay = `${i * 40}ms`;
    card.innerHTML = `
      <div class="ls-option__radio"></div>
      <div class="ls-option__text">
        <span class="ls-option__label">${window.escHtml(locale.name)}</span>
        <span class="ls-option__code">${window.escHtml(locale.code)}</span>
      </div>`;

    card.addEventListener("click", () => choose(locale.code));
    card.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        choose(locale.code);
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        focusCardAt(i + 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        focusCardAt(i - 1);
      }
    });

    cards.push(card);
    optionsEl.appendChild(card);
  });

  paintSelection();

  const continueHTML = btnContinue.innerHTML;
  btnContinue.addEventListener("click", () => {
    if (btnContinue.disabled) {
      return;
    }
    btnContinue.disabled = true;
    window.electronAPI?.loadSecurityCheck?.();
    window.armButtonRestore(btnContinue, continueHTML);
  });
});
