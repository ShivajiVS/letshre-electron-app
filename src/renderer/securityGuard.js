/**
 * Violation modal for the steps after the security check (permissions,
 * identity verification, role selection). Main keeps checking the machine,
 * pushes its state here and refuses every forward step until it is clear, so
 * this only shows that state and helps the candidate fix it.
 *
 * Include after i18n.js, rendererUtils.js and preflightModel.js, before the
 * page script. Exposes window.securityGuard.
 */

/* eslint-env browser */
"use strict";

(function () {
  const PM = window.PreflightModel;
  if (!PM) {
    return;
  }
  const api = window.electronAPI || {};

  const CLEAR_HOLD_MS = 1000;
  const MAX_APPS_SHOWN = 4;
  const MAX_CONFIRM_NAMES = 6;
  const STATUSES = new Set(["clear", "blocked", "unverified"]);
  const UNVERIFIED_CODES = new Set(["agent_unreachable", "check_unverified"]);

  let _state = { status: "clear", stage: null, seq: null, checking: false, issues: [] };
  const _listeners = new Set();

  let _dlg = null;
  let _confirmDlg = null;
  /** {kind: "kill" | "leave", apps, trigger, resolve} while the confirm step is open. */
  let _confirm = null;
  let _lastPageFocus = null;
  let _returnFocus = null;
  let _clearTimer = null;

  let _rechecking = false;
  let _recheckQueued = false;
  let _killing = 0;
  let _elevating = 0;
  let _canElevate = false;
  /** app key -> {kind: "closing" | "outcome" | "error", view?, elevated?} */
  const _rows = new Map();
  const _elevationTried = new Set();
  const _killConfirmed = new Set();

  function tr(key, fallback, params) {
    if (window.t) {
      const out = window.t(key, params);
      if (out !== key) {
        return out;
      }
    }
    if (!params) {
      return fallback;
    }
    return fallback.replace(/\{(\w+)\}/g, (match, token) =>
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
    );
  }

  function checkAgainLabel() {
    return tr("securityGuard.checkAgain", "Check again");
  }

  // ─── State

  function cleanText(value) {
    return typeof value === "string"
      ? value
          .replace(/\p{Cc}/gu, "")
          .trim()
          .slice(0, 80)
      : "";
  }

  function normApp(raw) {
    const process = PM.processLabel(raw?.process);
    const name = cleanText(raw?.name) || process;
    if (!name) {
      return null;
    }
    const pid = Number.isInteger(raw?.pid) && raw.pid > 0 ? raw.pid : null;
    return { process, name, pid, key: pid ? `pid:${pid}` : `app:${process || name}` };
  }

  function normIssue(raw) {
    const apps = Array.isArray(raw.apps) ? raw.apps.map(normApp).filter(Boolean) : [];
    return {
      category: typeof raw.category === "string" ? raw.category : "",
      code: typeof raw.code === "string" ? raw.code : "",
      apps,
      closable: raw.closable === true && apps.length > 0,
      count: Number.isInteger(raw.count) && raw.count > 0 ? raw.count : null,
    };
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || !STATUSES.has(raw.status)) {
      return null;
    }
    return {
      status: raw.status,
      stage: typeof raw.stage === "string" ? raw.stage : null,
      seq: Number.isFinite(raw.seq) ? raw.seq : null,
      checking: raw.checking === true,
      issues: Array.isArray(raw.issues)
        ? raw.issues.filter((i) => i && typeof i === "object").map(normIssue)
        : [],
    };
  }

  function isBlocked() {
    return _state.status !== "clear";
  }

  function getState() {
    return JSON.parse(JSON.stringify(_state));
  }

  function busy() {
    return _state.checking || _rechecking || _killing > 0;
  }

  function canKill(app) {
    if (!app.process) {
      return false;
    }
    return typeof (app.pid ? api.killThreatProcess : api.killProcess) === "function";
  }

  function issueClosable(issue) {
    return issue.closable && issue.apps.every(canKill);
  }

  function closableApps() {
    if (_state.status !== "blocked") {
      return [];
    }
    const seen = new Map();
    _state.issues.filter(issueClosable).forEach((i) =>
      i.apps.forEach((a) => {
        if (!seen.has(a.key)) {
          seen.set(a.key, a);
        }
      })
    );
    return [...seen.values()];
  }

  function isClosed(key) {
    const row = _rows.get(key);
    return row?.kind === "outcome" && (row.view === "closed" || row.view === "already-gone");
  }

  function openApps() {
    return closableApps().filter((a) => !isClosed(a.key));
  }

  /**
   * After a fresh check, an app still listed under "Closed" has come back; a
   * manual Check again also clears the failure states, as a rescan does on the
   * security check.
   */
  function syncRowStates({ fresh = false, manual = false } = {}) {
    const present = new Set();
    _state.issues.forEach((i) => i.apps.forEach((a) => present.add(a.key)));
    [..._rows.keys()].forEach((key) => {
      const row = _rows.get(key);
      if (!present.has(key)) {
        _rows.delete(key);
      } else if (row.kind !== "closing" && (manual || (fresh && isClosed(key)))) {
        _rows.delete(key);
      }
    });
  }

  function apply(raw, options) {
    const next = normalize(raw);
    if (!next) {
      return false;
    }
    if (next.seq !== null && _state.seq !== null && next.seq < _state.seq) {
      return false;
    }
    _state = next;
    syncRowStates(options);
    render();
    if (next.status === "clear") {
      holdClear();
    } else {
      cancelClearHold();
      open();
    }
    notify();
    return true;
  }

  function notify() {
    const snapshot = getState();
    _listeners.forEach((cb) => {
      try {
        cb(snapshot);
      } catch (err) {
        console.warn("[securityGuard] listener threw:", err);
      }
    });
  }

  // ─── Copy

  const CATEGORY_TITLES = {
    hdmi: ["preflight.hdmiTitle", "External Displays"],
    meeting: ["preflight.meetingTitle", "Meeting Apps"],
    screen: ["preflight.screenTitle", "Screen Recording & Sharing"],
    wireless: ["preflight.wirelessTitle", "Remote Access & Casting"],
    browser: ["preflight.browserTitle", "Web Browsers"],
    ai: ["preflight.aiTitle", "AI Assistant Apps"],
    agent: ["preflightResults.agentTitle", "Deep System Scan"],
  };

  // Agent findings read better by what was found than as "Deep System Scan".
  const CODE_TITLES = {
    ai_tool: ["preflightResults.threatAiTool", "AI assistant app"],
    overlay: ["preflightResults.threatOverlay", "Hidden screen overlay"],
    renamed_app: ["preflightResults.threatRenamedApp", "Renamed blocked app"],
    remote_session: ["preflightResults.threatRemoteSession", "Remote desktop session"],
    virtual_machine: ["preflightResults.threatVirtualMachine", "Virtual machine"],
    suspicious_activity: ["preflightResults.threatGeneric", "Suspicious activity"],
  };

  function issueTitle(issue) {
    const byCode = CODE_TITLES[issue.code];
    if (byCode && (issue.category === "agent" || !CATEGORY_TITLES[issue.category])) {
      return tr(...byCode);
    }
    return tr(...(CATEGORY_TITLES[issue.category] || CODE_TITLES.suspicious_activity));
  }

  /** What to do when there's nothing to close from here. */
  function issueHint(issue) {
    switch (issue.code) {
      case "external_display":
        return issue.count
          ? tr(
              "securityGuard.hintDisplayCount",
              issue.count === 1
                ? "{count} display is connected. Unplug the extra ones so only one screen is in use."
                : "{count} displays are connected. Unplug the extra ones so only one screen is in use.",
              { count: issue.count }
            )
          : tr(
              "securityGuard.hintDisplay",
              "Unplug any extra monitors or TVs so only one screen is in use."
            );
      case "mirrored_display":
        return tr(
          "securityGuard.hintMirrored",
          "Stop mirroring your screen and unplug the extra display."
        );
      case "remote_session":
      case "virtual_machine": {
        const hint = PM.threatHint(issue.code);
        return tr(hint.key, hint.fallback);
      }
      case "agent_unreachable":
      case "check_unverified":
        return tr("securityGuard.hintUnverified", "We couldn't check this just now.");
      default:
        return issue.apps.length > 0
          ? tr("securityGuard.hintManual", "Close it yourself, then check again.")
          : tr("securityGuard.hintSuspicious", "Close any apps you don't need, then check again.");
    }
  }

  const HEAD = {
    close: {
      icon: "warning",
      tone: "fail",
      title: ["securityGuard.titleClose", "Close these to continue"],
      desc: [
        "securityGuard.descClose",
        "These started after your security check. You can continue once they're closed.",
      ],
    },
    fix: {
      icon: "warning",
      tone: "fail",
      title: ["securityGuard.titleFix", "Fix these to continue"],
      desc: [
        "securityGuard.descFix",
        "These changed after your security check. You can continue once they're fixed.",
      ],
    },
    unverified: {
      icon: "question",
      tone: "unverified",
      title: ["securityGuard.titleUnverified", "We can't check your system right now"],
      desc: [
        "securityGuard.descUnverified",
        "Our security check didn't finish. Wait a moment, then check again.",
      ],
    },
    clear: {
      icon: "check",
      tone: "ok",
      title: ["securityGuard.titleClear", "All clear"],
      desc: ["securityGuard.descClear", "Thanks. You can carry on."],
    },
  };

  function headKind() {
    if (_state.status === "clear") {
      return "clear";
    }
    if (_state.status === "unverified") {
      return "unverified";
    }
    return _state.issues.length > 0 && _state.issues.every(issueClosable) ? "close" : "fix";
  }

  function killHint(view, name) {
    const params = { name, rescan: checkAgainLabel() };
    switch (view) {
      case "elevate":
        return tr(
          "preflightResults.killElevateHint",
          "{name} needs administrator rights. Your system will ask you to confirm before it closes.",
          params
        );
      case "respawned":
        return tr(
          "preflightResults.killRespawnedHint",
          "{name} reopened after closing. Turn off its auto-start setting or sign out of it, then click {rescan}.",
          params
        );
      case "admin":
        return tr(
          "preflightResults.killAdminHint",
          "{name} needs administrator rights to close. Close it from its own window, then click {rescan}.",
          params
        );
      case "still-running":
        return tr(
          "preflightResults.killStillClosingHint",
          "{name} is still shutting down. Wait a few seconds, then click Close again.",
          params
        );
      default:
        return tr(
          "preflightResults.killGenericHint",
          "We couldn't close {name}. Close it yourself, then click {rescan}.",
          params
        );
    }
  }

  /** Mirrors the security check's kill row: button look, lock and hint per outcome. */
  function killView(app) {
    const row = _rows.get(app.key);
    const failed = {
      variant: "failed",
      icon: "x",
      label: tr("preflightResults.closeFailedManual", "Couldn't close — try again"),
      hint: killHint("failed", app.name),
      tone: "fail",
    };
    if (!row) {
      return {
        variant: "",
        icon: "close",
        label: tr("preflightResults.close", "Close"),
        aria: tr("preflightResults.closeApp", "Close {name}", { name: app.name }),
      };
    }
    if (row.kind === "closing") {
      return {
        variant: "busy",
        icon: "spin",
        locked: true,
        label: row.elevated
          ? tr("preflightResults.killElevateWaiting", "Waiting for your permission…")
          : tr("preflightResults.closing", "Closing…"),
      };
    }
    if (row.kind === "error") {
      return {
        ...failed,
        label: tr("preflightResults.closeErrorManual", "Something went wrong — try again"),
      };
    }
    switch (row.view) {
      case "closed":
      case "already-gone":
        return {
          variant: "killed",
          icon: "check",
          locked: true,
          row: "closed",
          label:
            row.view === "already-gone"
              ? tr("preflightResults.alreadyClosed", "Already closed")
              : tr("preflightResults.closed", "Closed"),
        };
      case "elevate":
        return {
          variant: "elevate",
          icon: "lock",
          row: "blocked",
          label: tr("preflightResults.killElevateBtn", "Close with admin rights"),
          hint: killHint("elevate", app.name),
          tone: "fail",
        };
      case "respawned":
        return {
          variant: "muted",
          icon: "reopen",
          locked: true,
          row: "respawned",
          label: tr("preflightResults.killRespawnedBtn", "Reopened itself"),
          hint: killHint("respawned", app.name),
          tone: "fail",
        };
      case "admin":
        return {
          variant: "muted",
          icon: "lock",
          locked: true,
          row: "blocked",
          label: tr("preflightResults.killAdminBtn", "Needs admin rights"),
          hint: killHint("admin", app.name),
          tone: "fail",
        };
      case "still-running":
        return {
          variant: "retry",
          icon: "clock",
          label: tr("preflightResults.killStillClosingBtn", "Still closing — try again"),
          hint: killHint("still-running", app.name),
          tone: "pending",
        };
      default:
        return failed;
    }
  }

  const KILL_ALL_SUMMARY = {
    "all-closed": ["preflightResults.allClosedRescanning", "All closed — checking again…"],
    reopened: ["preflightResults.killAllReopened", "Some apps reopened themselves"],
    failed: ["preflightResults.someFailedToClose", "Some apps couldn't be closed"],
    partial: [
      "preflightResults.killAllPartial",
      "{closed} of {total} closed — close the rest yourself",
    ],
  };

  // ─── Icons

  const PATHS = {
    warning:
      "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
    question:
      "M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    check: "M5 13l4 4L19 7",
    x: "M6 18L18 6M6 6l12 12",
    refresh:
      "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15",
    lock: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
    clock: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
  };

  const ICON_PATHS = {
    warning: [PATHS.warning, 2],
    question: [PATHS.question, 2],
    check: [PATHS.check, 2.5],
    close: [PATHS.x, 2],
    x: [PATHS.x, 2.5],
    spin: [PATHS.refresh, 2],
    reopen: [PATHS.refresh, 2],
    lock: [PATHS.lock, 2],
    clock: [PATHS.clock, 2],
  };

  function iconMarkup(name, cls) {
    const [d, width] = ICON_PATHS[name] || ICON_PATHS.warning;
    const spin = name === "spin" ? " sg-spin" : "";
    return (
      `<svg class="${cls}${spin}" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
      `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="${width}" d="${d}"></path></svg>`
    );
  }

  /** Icon + text label, rebuilt only when it changes so spinners don't restart on every push. */
  function paintButton(btn, icon, label) {
    const sig = `${icon}|${label}`;
    if (btn.dataset.paint === sig) {
      return;
    }
    btn.dataset.paint = sig;
    btn.innerHTML = icon ? iconMarkup(icon, "sg-icon") : "";
    const span = document.createElement("span");
    span.textContent = label;
    btn.appendChild(span);
  }

  function setText(node, text) {
    if (node.textContent !== text) {
      node.textContent = text;
    }
  }

  // ─── DOM

  const DIALOG_MARKUP = `
    <div class="sg-panel">
      <div class="sg-head">
        <span id="sg-icon" class="sg-head__icon" aria-hidden="true"></span>
        <div class="sg-head__text">
          <h2 id="sg-title" class="sg-title" tabindex="-1"></h2>
          <p id="sg-desc" class="sg-desc"></p>
        </div>
      </div>
      <p id="sg-status" class="sg-status" hidden></p>
      <div class="sg-body">
        <ul id="sg-issues" class="sg-issues"></ul>
      </div>
      <div id="sg-actions" class="sg-actions">
        <div class="sg-actions__main">
          <button id="sg-close-all" type="button" class="btn btn--secondary sg-close-all"></button>
          <button id="sg-recheck" type="button" class="btn btn--primary sg-recheck"></button>
        </div>
        <button id="sg-leave" type="button" class="sg-leave"></button>
      </div>
      <div id="sg-announcer" class="sg-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;

  const CONFIRM_MARKUP = `
    <div class="sg-panel sg-panel--confirm">
      <h2 id="sg-confirm-title" class="sg-confirm__title"></h2>
      <p id="sg-confirm-body" class="sg-confirm__body"></p>
      <ul id="sg-confirm-list" class="sg-confirm__list"></ul>
      <div class="sg-confirm__actions">
        <button id="sg-confirm-cancel" type="button" class="btn btn--secondary"></button>
        <button id="sg-confirm-ok" type="button" class="btn btn--danger"></button>
      </div>
    </div>`;

  function el(id) {
    return document.getElementById(id);
  }

  /** Keeps Tab inside the dialog, as on the security check. */
  function trapTab(dlg) {
    dlg.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") {
        return;
      }
      const focusable = [...dlg.querySelectorAll("button:not(:disabled)")].filter(
        (b) => b.getClientRects().length > 0
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const at = focusable.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function ensureDialog() {
    if (_dlg) {
      return _dlg;
    }
    const dlg = document.createElement("dialog");
    dlg.id = "security-guard";
    dlg.className = "sg-dialog";
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", "sg-title");
    dlg.setAttribute("aria-describedby", "sg-desc");
    dlg.innerHTML = DIALOG_MARKUP;
    document.body.appendChild(dlg);
    _dlg = dlg;

    // Escape never closes it; only a clear state from main does.
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
      }
    });
    dlg.addEventListener("cancel", (e) => e.preventDefault());
    dlg.addEventListener("close", () => {
      if (isBlocked()) {
        setTimeout(open, 0);
      }
    });
    trapTab(dlg);

    el("sg-issues").addEventListener("click", (e) => {
      const btn = e.target.closest(".sg-app__close");
      if (btn && !btn.disabled) {
        onCloseClick(btn.closest(".sg-app")?.dataset.key, btn);
      }
    });
    el("sg-close-all").addEventListener("click", onCloseAll);
    el("sg-recheck").addEventListener("click", () => recheck({ manual: true }));
    el("sg-leave").addEventListener("click", onLeave);
    return dlg;
  }

  function ensureConfirmDialog() {
    if (_confirmDlg) {
      return _confirmDlg;
    }
    const dlg = document.createElement("dialog");
    dlg.id = "security-guard-confirm";
    dlg.className = "sg-dialog sg-dialog--confirm";
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", "sg-confirm-title");
    dlg.setAttribute("aria-describedby", "sg-confirm-body");
    dlg.innerHTML = CONFIRM_MARKUP;
    document.body.appendChild(dlg);
    _confirmDlg = dlg;

    el("sg-confirm-cancel").addEventListener("click", () => closeConfirm(false));
    el("sg-confirm-ok").addEventListener("click", () => closeConfirm(true));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeConfirm(false);
    });
    dlg.addEventListener("close", () => {
      if (_confirm) {
        closeConfirm(false);
      }
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) {
        closeConfirm(false);
      }
    });
    trapTab(dlg);
    return dlg;
  }

  function isOpen() {
    return !!_dlg?.open;
  }

  function focusTitle() {
    el("sg-title")?.focus({ preventScroll: true });
  }

  function open() {
    ensureDialog();
    if (_dlg.open) {
      return;
    }
    // A forward button disabled mid-request may already have lost focus by the
    // time main refuses, so fall back to the page control that last had it.
    if (!_returnFocus) {
      const active = document.activeElement;
      _returnFocus = active && active !== document.body ? active : _lastPageFocus;
    }
    render();
    try {
      _dlg.showModal();
    } catch {
      _dlg.setAttribute("open", "");
    }
    focusTitle();
  }

  function closeDialog() {
    cancelClearHold();
    closeConfirm(false);
    if (!_dlg?.open) {
      return;
    }
    _dlg.close();
    const target = _returnFocus;
    _returnFocus = null;
    if (target?.isConnected && !target.disabled && target.getClientRects().length > 0) {
      target.focus();
    }
  }

  function holdClear() {
    if (!isOpen() || _clearTimer) {
      return;
    }
    closeConfirm(false);
    announce(tr("securityGuard.titleClear", "All clear"));
    _clearTimer = setTimeout(() => {
      _clearTimer = null;
      if (!isBlocked()) {
        closeDialog();
      }
    }, CLEAR_HOLD_MS);
  }

  function cancelClearHold() {
    if (_clearTimer) {
      clearTimeout(_clearTimer);
      _clearTimer = null;
    }
  }

  function announce(text) {
    const node = el("sg-announcer");
    if (!node || !text) {
      return;
    }
    node.textContent = "";
    setTimeout(() => {
      node.textContent = text;
    }, 60);
  }

  // ─── Render

  function render() {
    if (!_dlg) {
      return;
    }
    const focusBefore = document.activeElement;
    paintHead();
    paintStatus();
    syncIssues();
    paintActions();
    if (_confirm) {
      paintConfirm();
    }
    // A live update may have removed or disabled the focused control.
    if (_dlg.open && !_confirmDlg?.open) {
      if (focusBefore && _dlg.contains(focusBefore) && focusBefore.isConnected) {
        if (document.activeElement !== focusBefore && !focusBefore.disabled) {
          focusBefore.focus({ preventScroll: true });
        }
      }
      if (!_dlg.contains(document.activeElement)) {
        focusTitle();
      }
    }
  }

  function paintHead() {
    const kind = headKind();
    const head = HEAD[kind];
    const icon = el("sg-icon");
    if (icon.dataset.kind !== kind) {
      icon.dataset.kind = kind;
      icon.className = `sg-head__icon sg-head__icon--${head.tone}`;
      icon.innerHTML = iconMarkup(head.icon, "sg-head__svg");
    }
    setText(el("sg-title"), tr(...head.title));
    setText(el("sg-desc"), tr(...head.desc));
    _dlg.classList.toggle("sg-dialog--clear", kind === "clear");
  }

  function paintStatus() {
    const status = el("sg-status");
    let text = "";
    if (isBlocked()) {
      if (_killing > 0) {
        text = tr("preflightResults.closing", "Closing…");
      } else if (_state.checking || _rechecking) {
        text = tr("securityGuard.checking", "Checking your system…");
      }
    }
    status.hidden = !text;
    _dlg.setAttribute("aria-busy", String(!!text));
    if (text) {
      paintButton(status, "spin", text);
    }
  }

  function issueKeys(issues) {
    const seen = new Map();
    return issues.map((i) => {
      const base = `${i.category}|${i.code}`;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n ? `${base}#${n}` : base;
    });
  }

  /** Keyed, in place: rows that stay keep their node, so focus and kill state survive a push. */
  function syncKeyed(container, keys, build, selector) {
    const existing = new Map();
    container.querySelectorAll(`:scope > ${selector}`).forEach((node) => {
      if (keys.includes(node.dataset.key) && !existing.has(node.dataset.key)) {
        existing.set(node.dataset.key, node);
      } else {
        node.remove();
      }
    });
    return keys.map((key, index) => {
      const node = existing.get(key) || build(key);
      const at = container.children[index];
      if (at !== node) {
        container.insertBefore(node, at || null);
      }
      return node;
    });
  }

  function syncIssues() {
    const list = el("sg-issues");
    const issues = _state.status === "blocked" ? _state.issues : [];
    list.parentElement.hidden = issues.length === 0;
    const nodes = syncKeyed(list, issueKeys(issues), buildIssue, ".sg-issue");
    nodes.forEach((node, i) => paintIssue(node, issues[i]));
  }

  function buildIssue(key) {
    const li = document.createElement("li");
    li.className = "sg-issue";
    li.dataset.key = key;
    li.innerHTML = `
      <div class="sg-issue__head">
        <span class="sg-issue__dot" aria-hidden="true"></span>
        <h3 class="sg-issue__title"></h3>
      </div>
      <p class="sg-issue__hint" hidden></p>
      <ul class="sg-apps"></ul>
      <p class="sg-more" hidden></p>`;
    return li;
  }

  function paintIssue(li, issue) {
    li.dataset.category = issue.category;
    li.dataset.code = issue.code;
    li.classList.toggle("sg-issue--unverified", UNVERIFIED_CODES.has(issue.code));
    setText(li.querySelector(".sg-issue__title"), issueTitle(issue));

    const closable = issueClosable(issue);
    const hint = li.querySelector(".sg-issue__hint");
    const hintText = closable ? "" : issueHint(issue);
    setText(hint, hintText);
    hint.hidden = !hintText;

    const shown = issue.apps.slice(0, MAX_APPS_SHOWN);
    const apps = li.querySelector(".sg-apps");
    apps.hidden = shown.length === 0;
    const nodes = syncKeyed(
      apps,
      shown.map((a) => a.key),
      buildApp,
      ".sg-app"
    );
    nodes.forEach((node, i) => paintApp(node, shown[i], closable));

    const hidden = issue.apps.length - shown.length;
    const more = li.querySelector(".sg-more");
    more.hidden = hidden <= 0;
    if (hidden > 0) {
      setText(
        more,
        tr("securityGuard.more", "+{count} more", {
          count: hidden,
        })
      );
    }
  }

  function buildApp(key) {
    const li = document.createElement("li");
    li.className = "sg-app";
    li.dataset.key = key;
    li.innerHTML = `
      <span class="sg-app__info">
        <span class="sg-app__name"></span>
        <span class="sg-app__process" hidden></span>
      </span>
      <p class="sg-app__hint" hidden></p>`;
    return li;
  }

  const ROW_MODIFIERS = ["sg-app--closed", "sg-app--respawned", "sg-app--blocked"];

  // App names come from the machine and the agent: text nodes only.
  function paintApp(li, app, closable) {
    li.dataset.process = app.process;
    if (app.pid) {
      li.dataset.pid = String(app.pid);
    } else {
      delete li.dataset.pid;
    }
    setText(li.querySelector(".sg-app__name"), app.name);
    const sub = li.querySelector(".sg-app__process");
    setText(sub, app.process && app.process !== app.name ? app.process : "");
    sub.hidden = !sub.textContent;

    let btn = li.querySelector(".sg-app__close");
    const hint = li.querySelector(".sg-app__hint");
    li.classList.remove(...ROW_MODIFIERS);
    if (!closable) {
      btn?.remove();
      hint.hidden = true;
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sg-app__close";
      li.insertBefore(btn, hint);
    }

    const view = killView(app);
    if (view.row) {
      li.classList.add(`sg-app--${view.row}`);
    }
    btn.className = view.variant ? `sg-app__close sg-app__close--${view.variant}` : "sg-app__close";
    btn.disabled = view.locked === true || busy();
    paintButton(btn, view.icon, view.label);
    if (view.aria) {
      btn.setAttribute("aria-label", view.aria);
    } else {
      btn.removeAttribute("aria-label");
    }
    setText(hint, view.hint || "");
    hint.hidden = !view.hint;
    hint.className = view.tone ? `sg-app__hint sg-app__hint--${view.tone}` : "sg-app__hint";
  }

  function paintActions() {
    const status = _state.status;
    const isBusy = busy();

    const actions = el("sg-actions");
    actions.hidden = status === "clear";

    const count = openApps().length;
    const closeAll = el("sg-close-all");
    closeAll.hidden = status !== "blocked" || count < 2;
    closeAll.disabled = isBusy;
    paintButton(
      closeAll,
      "close",
      tr("preflightResults.closeAll", "Close all {count} apps", { count })
    );

    const recheckBtn = el("sg-recheck");
    recheckBtn.disabled = isBusy;
    paintButton(recheckBtn, "", checkAgainLabel());

    // Stays usable while a check runs so a stuck check never traps the candidate;
    // only an open elevation prompt holds it.
    const leave = el("sg-leave");
    leave.disabled = _elevating > 0;
    setText(leave, tr("securityGuard.leave", "Leave setup"));
  }

  // ─── Confirm step

  function confirmStep(kind, apps, trigger) {
    const dlg = ensureConfirmDialog();
    if (_confirm) {
      closeConfirm(false);
    }
    return new Promise((resolve) => {
      _confirm = { kind, apps, trigger, resolve };
      paintConfirm();
      try {
        dlg.showModal();
      } catch {
        _confirm = null;
        resolve(false);
        return;
      }
      el("sg-confirm-cancel").focus();
    });
  }

  function closeConfirm(confirmed) {
    if (!_confirm) {
      return;
    }
    const { trigger, resolve } = _confirm;
    _confirm = null;
    if (_confirmDlg?.open) {
      _confirmDlg.close();
    }
    if (trigger?.isConnected && !trigger.disabled) {
      trigger.focus();
    } else if (isOpen()) {
      focusTitle();
    }
    resolve(confirmed);
  }

  function paintConfirm() {
    const { kind, apps } = _confirm;
    const title = el("sg-confirm-title");
    const body = el("sg-confirm-body");
    const list = el("sg-confirm-list");
    const ok = el("sg-confirm-ok");
    const cancel = el("sg-confirm-cancel");

    if (kind === "leave") {
      setText(title, tr("securityGuard.leaveTitle", "Leave setup?"));
      setText(
        body,
        tr(
          "securityGuard.leaveBody",
          "You'll go back to your dashboard. You can start again from there."
        )
      );
      list.hidden = true;
      setText(ok, tr("securityGuard.leave", "Leave setup"));
      setText(cancel, tr("securityGuard.stay", "Stay"));
      return;
    }

    const count = apps.length;
    const one = count === 1;
    setText(
      title,
      tr(
        "preflightResults.killConfirmTitle",
        one ? "Close this app?" : "Close these {count} apps?",
        {
          count,
        }
      )
    );
    setText(
      body,
      tr(
        "preflightResults.killConfirmBody",
        one
          ? "Any unsaved work in it will be lost. Save your work first if you need to."
          : "Any unsaved work in them will be lost. Save your work first if you need to.",
        { count }
      )
    );
    const names = apps.slice(0, MAX_CONFIRM_NAMES).map((a) => {
      const li = document.createElement("li");
      li.textContent = a.name;
      return li;
    });
    if (count > MAX_CONFIRM_NAMES) {
      const li = document.createElement("li");
      li.className = "sg-confirm__more";
      li.textContent = tr("securityGuard.more", "+{count} more", {
        count: count - MAX_CONFIRM_NAMES,
      });
      names.push(li);
    }
    list.replaceChildren(...names);
    list.hidden = false;
    setText(
      ok,
      tr("preflightResults.killConfirmAction", one ? "Close app" : "Close {count} apps", { count })
    );
    setText(cancel, tr("preflightResults.killConfirmCancel", "Cancel"));
  }

  // ─── Actions

  function findApp(key) {
    return closableApps().find((a) => a.key === key) || null;
  }

  async function onCloseClick(key, trigger) {
    const app = key ? findApp(key) : null;
    if (!app || busy()) {
      return;
    }
    const row = _rows.get(key);
    const elevated = row?.kind === "outcome" && row.view === "elevate";
    if (!elevated && !_killConfirmed.has(key)) {
      const ok = await confirmStep("kill", [app], trigger);
      if (!ok || !findApp(key) || busy()) {
        return;
      }
      _killConfirmed.add(key);
    }
    await closeApps([app], elevated);
  }

  async function onCloseAll() {
    const trigger = el("sg-close-all");
    const apps = openApps();
    if (apps.length === 0 || busy()) {
      return;
    }
    const ok = await confirmStep("kill", apps, trigger);
    if (!ok || busy()) {
      return;
    }
    const still = new Set(openApps().map((a) => a.key));
    const targets = apps.filter((a) => still.has(a.key));
    if (targets.length === 0) {
      return;
    }
    targets.forEach((a) => _killConfirmed.add(a.key));
    await closeApps(targets, false);
  }

  async function attempt(app, call) {
    try {
      return [{ app, raw: await call(), threw: false }];
    } catch {
      return [{ app, raw: null, threw: true }];
    }
  }

  async function killAllByName(apps) {
    let results = [];
    try {
      results = await api.killAllProcesses(apps.map((a) => a.process));
    } catch {
      results = [];
    }
    // A missing entry is a failure, never a success.
    const lookup = PM.indexKillResults(results);
    return apps.map((a) => ({ app: a, raw: lookup(a.process), threw: false }));
  }

  async function requestKills(apps, elevated) {
    const byName = apps.filter((a) => !a.pid);
    const jobs = apps
      .filter((a) => a.pid)
      .map((a) => attempt(a, () => api.killThreatProcess(a.pid, a.process)));
    if (byName.length > 1 && typeof api.killAllProcesses === "function") {
      jobs.push(killAllByName(byName));
    } else {
      byName.forEach((a) =>
        jobs.push(
          attempt(a, () =>
            elevated ? api.killProcessElevated(a.process) : api.killProcess(a.process)
          )
        )
      );
    }
    return (await Promise.all(jobs)).flat();
  }

  async function closeApps(apps, elevated) {
    if (elevated) {
      apps.forEach((a) => _elevationTried.add(a.process));
      _elevating += 1;
    }
    _killing += 1;
    apps.forEach((a) => _rows.set(a.key, { kind: "closing", elevated }));
    render();

    let results = [];
    try {
      results = await requestKills(apps, elevated);
    } finally {
      _killing -= 1;
      if (elevated) {
        _elevating -= 1;
      }
    }

    const outcomes = results.map(({ app, raw, threw }) => {
      if (threw) {
        _rows.set(app.key, { kind: "error" });
        return { app, category: "failed", view: "failed" };
      }
      const norm = PM.normalizeKillResult(raw, app.process);
      const { category, view } = PM.killOutcomeView(norm, {
        canElevate: _canElevate && !app.pid && typeof api.killProcessElevated === "function",
        elevationTried: _elevationTried.has(app.process),
      });
      _rows.set(app.key, { kind: "outcome", view });
      return { app, category, view };
    });
    render();
    announceKills(outcomes);
    restoreKillFocus(apps);

    // An admin retry waits for the candidate; everything else gets a fresh check.
    if (isBlocked() && outcomes.some((o) => o.view !== "elevate")) {
      recheck();
    }
  }

  function announceKills(outcomes) {
    if (outcomes.length === 1) {
      const [{ app, category, view }] = outcomes;
      announce(
        category === "closed"
          ? tr("preflightResults.appClosed", "{name} closed.", { name: app.name })
          : killHint(view, app.name)
      );
      return;
    }
    const summary = PM.killAllOutcome(outcomes.map((o) => o.category));
    const [key, fallback] = KILL_ALL_SUMMARY[summary.summary] || KILL_ALL_SUMMARY.failed;
    announce(tr(key, fallback, { closed: summary.closed, total: summary.total }));
  }

  function restoreKillFocus(apps) {
    if (!isOpen() || _confirmDlg?.open) {
      return;
    }
    // The title only holds focus while the kill's own button was disabled.
    const active = document.activeElement;
    if (_dlg.contains(active) && active !== el("sg-title") && !active.disabled) {
      return;
    }
    const row =
      apps.length === 1
        ? _dlg.querySelector(`.sg-app[data-key="${CSS.escape(apps[0].key)}"]`)
        : null;
    const btn = row?.querySelector(".sg-app__close");
    if (btn && !btn.disabled) {
      btn.focus();
    } else {
      focusTitle();
    }
  }

  async function recheck({ manual = false } = {}) {
    if (typeof api.recheckSecurityGuard !== "function") {
      return;
    }
    if (_rechecking) {
      _recheckQueued = true;
      return;
    }
    _rechecking = true;
    render();
    let fresh = null;
    try {
      fresh = await api.recheckSecurityGuard();
    } catch (err) {
      console.warn("[securityGuard] recheck failed:", err);
    }
    _rechecking = false;
    if (!fresh || !apply(fresh, { fresh: true, manual })) {
      render();
    }
    if (_recheckQueued) {
      _recheckQueued = false;
      if (isBlocked()) {
        recheck();
      }
    }
  }

  async function onLeave() {
    const trigger = el("sg-leave");
    if (trigger.disabled) {
      return;
    }
    const ok = await confirmStep("leave", [], trigger);
    if (ok) {
      api.loadDashboard?.();
    }
  }

  // ─── Public API

  function onChange(cb) {
    if (typeof cb !== "function") {
      return () => {};
    }
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  }

  function show(state) {
    if (state !== undefined) {
      apply(state);
    }
    if (isBlocked()) {
      open();
    }
  }

  /** @returns {boolean} true when a blocked/unverified refusal was shown in the modal. */
  function handleRefusal(res) {
    if (!res || res.ok !== false || (res.reason !== "blocked" && res.reason !== "unverified")) {
      return false;
    }
    if (normalize(res.guard)) {
      // An older guard than the one already shown changes nothing.
      if (!apply(res.guard) && isBlocked()) {
        open();
      }
      return true;
    }
    if (!isBlocked()) {
      // Refused without details: open on the reason and ask main for a fresh answer.
      _state = { ..._state, status: res.reason, checking: false, issues: [] };
      notify();
      recheck();
    }
    open();
    return true;
  }

  window.securityGuard = { isBlocked, getState, onChange, show, handleRefusal };

  window.i18n?.registerRenderer?.(render);
  // Main answers before the bundle lands, and the page stays hidden until then.
  const i18nReady = Promise.resolve(window.i18n?.ready);

  document.addEventListener("focusin", (e) => {
    if (!_dlg?.contains(e.target) && !_confirmDlg?.contains(e.target)) {
      _lastPageFocus = e.target;
    }
  });

  Promise.resolve()
    .then(() => api.canElevate?.())
    .then((ok) => {
      _canElevate = ok === true;
    })
    .catch(() => {
      _canElevate = false;
    });

  if (typeof api.getSecurityGuardStatus === "function") {
    Promise.resolve()
      .then(() => Promise.all([api.getSecurityGuardStatus(), i18nReady]))
      .then(([s]) => apply(s))
      .catch((err) => console.warn("[securityGuard] status unavailable:", err));
  }
  api.onSecurityGuardStatus?.((s) => i18nReady.then(() => apply(s)));
})();
