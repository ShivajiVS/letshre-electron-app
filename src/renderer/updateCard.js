/**
 * Auto-updater card: a consent-first floating card in the bottom-right corner,
 * shared by every local page. The main process gates download and install
 * (never during an interview); this only reflects state and relays the user's
 * choice. Update-check failures never render anything.
 *
 * The interview and its violation screen are served by the interview site, which
 * never loads this script and can't reach the update channels (SCOPE.LOCAL).
 *
 * Include after i18n.js. Self-contained: it doesn't rely on rendererUtils.js or
 * a page-level tr(), since not every page loads those.
 */

/* eslint-env browser */
"use strict";

(function () {
  const api = window.electronAPI;
  if (!api?.onUpdateAvailable) {
    return;
  }

  let update = { kind: "idle", notesOpen: false };

  function tr(key, fallback, params) {
    if (window.t) {
      return window.t(key, params);
    }
    if (!params) {
      return fallback;
    }
    return fallback.replace(/\{(\w+)\}/g, (match, token) =>
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
    );
  }

  function esc(str) {
    return String(str || "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function locale() {
    return window.i18n?.getLocale?.() || "en";
  }

  /** Compact, locale-formatted byte count, e.g. "12.4 MB" / "12,4 MB". */
  function formatBytes(bytes) {
    if (!bytes || bytes < 0) {
      return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    const digits = n < 10 && i > 0 ? 1 : 0;
    const formatted = new Intl.NumberFormat(locale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
    return `${formatted} ${units[i]}`;
  }

  const ICONS = {
    download:
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
    check:
      '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>',
  };

  function cardBody(s) {
    const icon = s.kind === "downloaded" ? ICONS.check : ICONS.download;

    const head = (title, tone = "") => `
      <div class="update-card__head">
        <span class="update-card__icon ${tone}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg>
        </span>
        <span class="update-card__title">${title}</span>
        ${s.version ? `<span class="update-card__chip">v${esc(s.version)}</span>` : ""}
      </div>`;

    const notes = s.releaseNotes
      ? `<button type="button" class="update-card__notes-toggle" data-update-action="notes">
           ${s.notesOpen ? tr("updater.hideNotes", "Hide") : tr("updater.whatsNew", "What’s new")}
         </button>
         ${
           s.notesOpen
             ? `<div class="update-card__notes">${esc(
                 typeof s.releaseNotes === "string" ? s.releaseNotes : ""
               ).slice(0, 1200)}</div>`
             : ""
         }`
      : "";

    switch (s.kind) {
      case "available": {
        const size = s.sizeBytes ? ` (${formatBytes(s.sizeBytes)})` : "";
        return `
          ${head(tr("updater.available", "Update available"))}
          <p class="update-card__body">${tr("updater.downloadingInBackground", `Downloading in the background${size}…`, { size })}</p>
          ${notes}`;
      }
      case "downloading": {
        const pct = Math.max(0, Math.min(100, s.percent ?? 0));
        const pctText = new Intl.NumberFormat(locale(), {
          style: "percent",
          maximumFractionDigits: 0,
        }).format(pct / 100);
        const sizeLine =
          s.transferred && s.total ? `${formatBytes(s.transferred)} / ${formatBytes(s.total)}` : "";
        return `
          ${head(tr("updater.downloading", "Downloading update"))}
          <div class="update-card__progress"><div class="update-card__progress-bar" style="width:${pct}%"></div></div>
          <p class="update-card__meta"><span>${pctText}</span><span>${sizeLine}</span></p>`;
      }
      case "downloaded":
        return `
          ${head(tr("updater.ready", "Update ready"), "update-card__icon--ok")}
          <p class="update-card__body">${tr("updater.readyBody", "It installs automatically when you close the app.")}</p>
          <div class="update-card__actions">
            <button type="button" class="update-card__btn update-card__btn--primary" data-update-action="install">${tr("updater.updateNow", "Update now")}</button>
            <button type="button" class="update-card__btn update-card__btn--ghost" data-update-action="dismiss">${tr("updater.dismiss", "Dismiss")}</button>
          </div>
          <p class="update-card__hint">${tr("updater.readyHint", '"Update now" closes the app and installs — reopen from your interview link.')}</p>`;
      default:
        return "";
    }
  }

  function render() {
    const existing = document.getElementById("update-card");
    if (update.kind === "idle") {
      existing?.remove();
      return;
    }
    if (!document.body) {
      return;
    }

    let card = existing;
    if (!card) {
      card = document.createElement("div");
      card.id = "update-card";
      card.className = "update-card";
      card.setAttribute("role", "status");
      card.setAttribute("aria-live", "polite");
      card.addEventListener("click", onAction);
      document.body.appendChild(card);
    }
    card.innerHTML = cardBody(update);
  }

  function set(next) {
    update = { ...update, ...next };
    render();
  }

  function onAction(e) {
    const action = e.target.closest("[data-update-action]")?.dataset.updateAction;
    if (action === "install") {
      api.installUpdate?.();
    } else if (action === "notes") {
      set({ notesOpen: !update.notesOpen });
    } else if (action === "dismiss") {
      set({ kind: "idle" });
    }
  }

  api.onUpdateAvailable((data) =>
    set({
      kind: "available",
      version: data?.version,
      sizeBytes: data?.sizeBytes ?? null,
      releaseNotes: data?.releaseNotes ?? null,
    })
  );
  api.onUpdateProgress?.((data) =>
    set({
      kind: "downloading",
      percent: data?.percent ?? 0,
      transferred: data?.transferred ?? null,
      total: data?.total ?? null,
    })
  );
  api.onUpdateDownloaded?.((data) => set({ kind: "downloaded", version: data?.version }));
  api.onUpdateError?.(({ error } = {}) => {
    // Not candidate-actionable (offline, no release yet, feed parse) — log only.
    console.warn("[updater] background update check failed (ignored):", error);
  });

  // Events fire while no page is listening (between navigations, or before this
  // page loaded), so pull the current state once instead of waiting for the next.
  api
    .getUpdateState?.()
    .then((s) => {
      if (!s || update.kind !== "idle") {
        return;
      }
      if (s.downloaded) {
        set({ kind: "downloaded", version: s.version });
      } else if (s.state === "downloading") {
        set({ kind: "downloading", percent: s.percent, version: s.version });
      } else if (s.state === "available") {
        set({
          kind: "available",
          version: s.version,
          sizeBytes: s.sizeBytes,
          releaseNotes: s.releaseNotes,
        });
      }
    })
    .catch(() => {});

  // Re-render in the new language when the candidate switches it, and once the
  // translation bundle loads (render() before that falls back to English).
  window.i18n?.registerRenderer?.(render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  }
})();
