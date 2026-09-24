/* global module */
"use strict";

// Pure, DOM-free logic for the security-check page. Loaded as a classic script
// (window.PreflightModel) and required directly by the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.PreflightModel = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PASS = "pass";
  const FAIL = "fail";
  const UNVERIFIED = "unverified";

  const CHECK_IDS = Object.freeze([
    "hdmi",
    "meeting",
    "screen",
    "wireless",
    "browser",
    "ai",
    "agent",
  ]);
  const LIVE_CHECK_IDS = Object.freeze(["hdmi", "meeting", "screen", "wireless", "browser", "ai"]);

  const UNVERIFIED_STREAK_FOR_SUPPORT = 2;

  // ── Scan tokens

  const TOKEN_RE = /^[A-Za-z0-9-]{1,64}$/;

  function newScanToken(cryptoImpl) {
    const c = cryptoImpl || (typeof crypto !== "undefined" ? crypto : null);
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
    const rand = Math.random().toString(36).slice(2, 12) || "0";
    return `${Date.now().toString(36)}-${rand}`;
  }

  function isValidToken(token) {
    return typeof token === "string" && TOKEN_RE.test(token);
  }

  function belongsToScan(payload, token) {
    return (
      isValidToken(token) && !!payload && typeof payload === "object" && payload.token === token
    );
  }

  // ── Verdicts

  /** Anything that isn't a recognised pass/unverified blocks as a failure. */
  function toneOf(status) {
    if (status === PASS) {
      return "pass";
    }
    if (status === UNVERIFIED) {
      return "unverified";
    }
    return "fail";
  }

  function sameVerdict(a, b) {
    if (!a || !b) {
      return false;
    }
    const apps = (v) => (Array.isArray(v.blockedApps) ? v.blockedApps.join("\n") : "");
    return (
      a.id === b.id &&
      a.status === b.status &&
      a.reasonKey === b.reasonKey &&
      JSON.stringify(a.reasonParams || {}) === JSON.stringify(b.reasonParams || {}) &&
      apps(a) === apps(b) &&
      JSON.stringify(a.threats || []) === JSON.stringify(b.threats || [])
    );
  }

  /** @param {string[]} tones "scanning" | "pass" | "fail" | "unverified" per card */
  function summarize(tones) {
    const count = (t) => tones.filter((x) => x === t).length;
    const passed = count("pass");
    const failed = count("fail");
    const unverified = count("unverified");
    return {
      total: tones.length,
      done: passed + failed + unverified,
      passed,
      failed,
      unverified,
      attention: failed + unverified,
    };
  }

  /**
   * Two-column layout: wide cards take a full row. A compact card that would
   * otherwise sit alone next to a hole is widened too, so the grid never gaps.
   * @param {boolean[]} wide
   * @returns {boolean[]} whether each card spans both columns
   */
  function gridSpans(wide) {
    const spans = [];
    let column = 0;
    for (let i = 0; i < wide.length; i += 1) {
      if (wide[i]) {
        spans.push(true);
        column = 0;
      } else if (column === 0 && (i === wide.length - 1 || wide[i + 1])) {
        spans.push(true);
      } else {
        spans.push(false);
        column = column === 0 ? 1 : 0;
      }
    }
    return spans;
  }

  // ── Live (pre-proceed) status

  function readLiveStatus(payload) {
    if (!payload || typeof payload !== "object") {
      return { state: "unverified", apps: [], verdicts: [], displayChanged: false };
    }
    const verdicts = Array.isArray(payload.verdicts)
      ? payload.verdicts.filter(
          (v) => v && LIVE_CHECK_IDS.includes(v.id) && typeof v.status === "string"
        )
      : [];
    const apps = Array.isArray(payload.apps)
      ? payload.apps.filter((a) => typeof a === "string" && a.length > 0)
      : [];

    let state;
    if (payload.clean === true) {
      state = "clean";
    } else if (payload.unverified === true) {
      state = "unverified";
    } else {
      state = "dirty";
    }
    // A clean flag never outranks a verdict that says otherwise.
    if (state !== "dirty" && verdicts.some((v) => toneOf(v.status) === "fail")) {
      state = "dirty";
    } else if (state === "clean" && verdicts.some((v) => v.status === UNVERIFIED)) {
      state = "unverified";
    }

    const displayChanged = verdicts.some((v) => v.id === "hdmi" && toneOf(v.status) === "fail");
    return { state, apps, verdicts, displayChanged };
  }

  // ── Kill results

  const SUCCESS_KILL_OUTCOMES = new Set(["closed", "already-gone"]);
  const KNOWN_KILL_OUTCOMES = new Set([
    "closed",
    "already-gone",
    "access-denied",
    "respawned",
    "still-running",
    "not-blocked",
    "own-process",
    "spawn-error",
    "unsupported",
  ]);

  /**
   * A recognised `outcome` decides success; `success` alone is only trusted
   * when no outcome came back, so success:true + respawned still reads as failed.
   */
  function normalizeKillResult(raw, processName) {
    const outcome =
      typeof raw?.outcome === "string" && KNOWN_KILL_OUTCOMES.has(raw.outcome) ? raw.outcome : null;
    return {
      processName: typeof raw?.processName === "string" ? raw.processName : processName,
      success: outcome ? SUCCESS_KILL_OUTCOMES.has(outcome) : raw?.success === true,
      outcome,
      serviceBacked: raw?.serviceBacked === true,
    };
  }

  /**
   * @returns {{category: string, view: string}} category drives the rescan
   *   decision; view picks the row's label and hint.
   */
  function killOutcomeView(norm, options) {
    const { canElevate = false, elevationTried = false } = options || {};
    const canOfferElevation = canElevate && !elevationTried;

    if (norm.success) {
      return {
        category: "closed",
        view: norm.outcome === "already-gone" ? "already-gone" : "closed",
      };
    }
    if (norm.outcome === "respawned") {
      // Only elevation stops a service that keeps restarting the app.
      return {
        category: "respawned",
        view: norm.serviceBacked && canOfferElevation ? "elevate" : "respawned",
      };
    }
    if (norm.outcome === "access-denied") {
      return { category: "access-denied", view: canOfferElevation ? "elevate" : "admin" };
    }
    if (norm.outcome === "still-running") {
      return { category: "still-running", view: "still-running" };
    }
    return { category: "failed", view: "failed" };
  }

  /** Mirrors validateProcessName() in src/main/ipcHandlers.js. */
  function sanitiseProcessKey(name) {
    return String(name || "").replace(/[^\w.\- ]/g, "");
  }

  /**
   * Kill-all results come back under the sanitised spelling, so look them up
   * both ways. Ambiguous sanitised keys are dropped rather than guessed.
   */
  function indexKillResults(results) {
    const byName = new Map();
    const bySanitised = new Map();
    const collided = new Set();
    (Array.isArray(results) ? results : []).forEach((r) => {
      if (!r || typeof r.processName !== "string") {
        return;
      }
      byName.set(r.processName, r);
      const key = sanitiseProcessKey(r.processName);
      if (bySanitised.has(key)) {
        collided.add(key);
      } else {
        bySanitised.set(key, r);
      }
    });
    collided.forEach((key) => bySanitised.delete(key));

    return (name) =>
      byName.has(name) ? byName.get(name) : bySanitised.get(sanitiseProcessKey(name));
  }

  /**
   * @param {string[]} categories one killOutcomeView category per app
   * @returns {{summary: string, closed: number, total: number, rescan: string}}
   *   rescan: "evidence" (name the culprits), "plain", or "none"
   */
  function killAllOutcome(categories) {
    const count = (c) => categories.filter((x) => x === c).length;
    const total = categories.length;
    const closed = count("closed");
    const respawned = count("respawned");
    const denied = count("access-denied");
    const retryable = count("still-running");

    if (total > 0 && closed === total) {
      return { summary: "all-closed", closed, total, rescan: "plain" };
    }
    let summary = "partial";
    if (respawned > 0) {
      summary = "reopened";
    } else if (closed === 0) {
      summary = "failed";
    }
    let rescan = "none";
    if (respawned > 0 || denied > 0) {
      rescan = "evidence";
    } else if (closed > 0 || retryable > 0) {
      rescan = "plain";
    }
    return { summary, closed, total, rescan };
  }

  /** What to do after a kill: name what a rescan can't fix, or rescan within the cap. */
  function autoRescanDecision({ respawned = [], accessDenied = [], count = 0, max = 3 } = {}) {
    if (respawned.length > 0) {
      return "halt-respawned";
    }
    if (accessDenied.length > 0) {
      return "halt-admin";
    }
    if (count >= max) {
      return "halt-cap";
    }
    return "rescan";
  }

  function scanErrorDecision(retryCount, max) {
    return { retry: retryCount < max, attempt: retryCount + 1 };
  }

  function shouldOfferSupport({ unverifiedStreak = 0, retryCapHit = false } = {}) {
    return retryCapHit === true || unverifiedStreak >= UNVERIFIED_STREAK_FOR_SUPPORT;
  }

  function shouldRescanOnFocus(s) {
    return (
      s.problem === true &&
      !s.scanning &&
      !s.killing &&
      !s.elevating &&
      !s.dialogOpen &&
      !s.proceeding &&
      !s.scheduled
    );
  }

  // ── Threats

  const SEVERITY = {
    CRITICAL: { key: "preflightResults.severityCritical", fallback: "Critical", tone: "strong" },
    HIGH: { key: "preflightResults.severityHigh", fallback: "High", tone: "strong" },
    MEDIUM: { key: "preflightResults.severityMedium", fallback: "Medium", tone: "soft" },
    LOW: { key: "preflightResults.severityLow", fallback: "Low", tone: "soft" },
  };

  function severityInfo(severity) {
    const s = typeof severity === "string" ? severity.trim().toUpperCase() : "";
    return SEVERITY[s] || { key: null, fallback: s.slice(0, 16), tone: "soft" };
  }

  const THREAT_TITLES = {
    suspicious_window_title: ["preflightResults.threatWindowTitle", "Suspicious window"],
    suspicious_network: ["preflightResults.threatNetwork", "Suspicious network activity"],
    suspicious_dll: ["preflightResults.threatModule", "Unexpected add-on inside an app"],
    browser_automation: ["preflightResults.threatAutomation", "Browser automation tool"],
    suspicious_window_class: ["preflightResults.threatWindowClass", "Suspicious app window"],
    ai_cheating_tool: ["preflightResults.threatAiTool", "AI assistant app"],
    transparent_overlay: ["preflightResults.threatOverlay", "Hidden screen overlay"],
    virtual_audio_device: ["preflightResults.threatVirtualAudio", "Virtual audio device"],
    remote_session: ["preflightResults.threatRemoteSession", "Remote desktop session"],
    virtual_machine: ["preflightResults.threatVirtualMachine", "Virtual machine"],
    renamed_blocked_app: ["preflightResults.threatRenamedApp", "Renamed blocked app"],
  };
  // Nothing to close for these, so the row says what to do instead.
  const THREAT_HINTS = {
    remote_session: [
      "preflightResults.threatRemoteSessionHint",
      "Run the interview directly on this computer, not over a remote connection.",
    ],
    virtual_machine: [
      "preflightResults.threatVirtualMachineHint",
      "Run the interview on your computer itself, not inside a virtual machine.",
    ],
  };
  const GENERIC_THREAT = ["preflightResults.threatGeneric", "Suspicious activity"];

  function threatTitle(type) {
    const [key, fallback] = Object.prototype.hasOwnProperty.call(THREAT_TITLES, type)
      ? THREAT_TITLES[type]
      : GENERIC_THREAT;
    return { key, fallback };
  }

  function threatHint(type) {
    if (!Object.prototype.hasOwnProperty.call(THREAT_HINTS, type)) {
      return null;
    }
    const [key, fallback] = THREAT_HINTS[type];
    return { key, fallback };
  }

  /** Image name only — agent paths and details can carry the user's name. */
  function processLabel(value) {
    if (typeof value !== "string") {
      return "";
    }
    const base = value.split(/[\\/]/).pop() || "";
    return base
      .replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, 80);
  }

  function isKillableThreat(threat) {
    return (
      !!threat &&
      Number.isInteger(threat.pid) &&
      threat.pid > 0 &&
      processLabel(threat.process).length > 0
    );
  }

  // ── Bounce reasons

  const BOUNCE_KEYS = {
    stale: ["preflightResults.bouncedStale", "Your last check expired, so we're checking again."],
    dirty: [
      "preflightResults.bouncedDirty",
      "Something changed since your last check, so we're checking again.",
    ],
    scanning: [
      "preflightResults.bouncedScanning",
      "A check was still running. Wait for this one to finish, then continue.",
    ],
  };

  function bounceReason(reason) {
    if (typeof reason !== "string" || !Object.prototype.hasOwnProperty.call(BOUNCE_KEYS, reason)) {
      return null;
    }
    const [key, fallback] = BOUNCE_KEYS[reason];
    return { key, fallback };
  }

  return {
    PASS,
    FAIL,
    UNVERIFIED,
    CHECK_IDS,
    LIVE_CHECK_IDS,
    UNVERIFIED_STREAK_FOR_SUPPORT,
    newScanToken,
    isValidToken,
    belongsToScan,
    toneOf,
    sameVerdict,
    summarize,
    gridSpans,
    readLiveStatus,
    normalizeKillResult,
    killOutcomeView,
    sanitiseProcessKey,
    indexKillResults,
    killAllOutcome,
    autoRescanDecision,
    scanErrorDecision,
    shouldOfferSupport,
    shouldRescanOnFocus,
    severityInfo,
    threatTitle,
    threatHint,
    processLabel,
    isKillableThreat,
    bounceReason,
  };
});
