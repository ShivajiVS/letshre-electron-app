const {
  IPC,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  INDETERMINATE_ESCALATION_THRESHOLD,
  HARD_BLOCK_GRACE_MS,
  API_BASE_URL,
  PREFLIGHT_HDMI_DEADLINE_MS,
  PREFLIGHT_PROCESS_DEADLINE_MS,
  PREFLIGHT_AGENT_DEADLINE_MS,
  PREFLIGHT_AGENT_SCAN_RESERVE_MS,
  PREFLIGHT_GLOBAL_DEADLINE_MS,
  PREFLIGHT_RESULT_MAX_AGE_MS,
  PREFLIGHT_REVERIFY_DEADLINE_MS,
  PRE_PROCEED_INTERVAL_MS,
  AGENT_RESTART_AFTER_FAILURES,
  MAX_UNACKED_VIOLATIONS,
} = require("../shared/constants");
const {
  CODE,
  codeForThreat,
  codeForProcessCategory,
  isKnownCode,
  isStrikeCode,
  threatEvent,
} = require("../shared/violationCodes");
const { getCurrentAccessToken } = require("../main/protocolHandler");
const crypto = require("crypto");
const axios = require("axios");
const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { checkProcesses, invalidateProcessCache } = require("./mirrorDetector");
const {
  PASS,
  FAIL,
  UNVERIFIED,
  mapHdmi,
  mapProcesses,
  mapAgent,
  buildVerdicts,
  canProceed,
} = require("./preflightVerdict");
const { getDisplayName, getThreatDisplayName, filterAgentStatus } = require("../shared/blocklist");
const { isBlocked } = require("../shared/blocklist");
const { expectedAgentSource } = require("../shared/agentBuild");
const { fetchAgentStatus, triggerAgentScan, onProcessStarted } = require("./agentClient");
const {
  whenAgentReady,
  isAgentReady,
  isAgentBlocked,
  restartAgent,
} = require("../main/agentManager");
const logger = require("../main/logger");
const preflightTelemetry = require("../main/preflightTelemetry");

const violationCache = new Map(); // event key → last-fired timestamp
const violationEscalation = new Map(); // event key → total fire count

let isSessionActive = false;

let detectionInterval = null;
let heartbeatInterval = null;
let stopWatchingStarts = null;
let startedTick = null;
let startedAgain = false;
let sessionWin = null;

/** Sent violations the site hasn't acknowledged yet, oldest first (id → payload). */
const unacked = new Map();
let hardBlockTimer = null;
let hardBlockId = null;

// Pre-proceed monitor state (see the monitor section below).
let preProceedInterval = null;
let _preProceedWin = null;
let _preProceedDesired = false;
let _monitorEpoch = 0;
let _tickSeq = 0;
let _appliedTickSeq = 0;
/** Latest live-monitor result; null until its first tick after a scan. */
let _live = null;

// Consecutive "indeterminate" results per check during a session. A check that
// keeps failing can't vouch for the system, so it escalates to a violation.
const indeterminateStreak = new Map(); // check key → consecutive indeterminate count

/** Check id reported with each escalation; the process check spans several. */
const ESCALATION_CATEGORY = { hdmi: "hdmi", mirror: "hdmi", agent: "agent", process: null };

/**
 * @param {Electron.BrowserWindow} win
 * @param {"hdmi"|"process"|"agent"|"mirror"} key
 * @param {string} label - human-readable check name for the violation message
 * @param {string} status - "clear" | "violation" | "indeterminate"
 */
function trackIndeterminate(win, key, label, status) {
  if (status !== "indeterminate") {
    indeterminateStreak.set(key, 0);
    return;
  }
  const streak = (indeterminateStreak.get(key) || 0) + 1;
  indeterminateStreak.set(key, streak);
  logger.warn(
    `[systemChecks] ${label} indeterminate (${streak}/${INDETERMINATE_ESCALATION_THRESHOLD})`
  );
  if (streak >= INDETERMINATE_ESCALATION_THRESHOLD) {
    sendViolation(
      win,
      `${label} could not be verified for ${streak} consecutive scans — possible tampering`,
      "high",
      {
        code: key === "agent" ? CODE.AGENT_UNREACHABLE : CODE.CHECK_UNVERIFIED,
        category: ESCALATION_CATEGORY[key] ?? null,
      }
    );
    indeterminateStreak.set(key, 0); // reset so cooldown governs re-fire cadence
  }
}

/** In-memory audit log — tamper-evident record of all session events. */
const auditLog = [];

/**
 * Appends an event to the in-memory audit log.
 * Keeps the last 500 entries to cap memory usage.
 * @param {"scan"|"violation"|"heartbeat"|"agent"} type
 * @param {object} data
 */
function appendAuditEvent(type, data) {
  auditLog.push({ timestamp: new Date().toISOString(), type, data });
  if (auditLog.length > 500) {
    auditLog.shift();
  }
}

/** Returns a copy of the audit log. Exposed via IPC GET_AUDIT_LOG. */
function getAuditLog() {
  return [...auditLog];
}

// ─── Backend violation reporting ──────────────────────────────────────────────
// Every violation is also POSTed to the backend, not just pushed to the renderer:
// the page can be reloading or down when it's pushed, so the backend POST is what
// makes the server the authority that can actually terminate/flag the session.
// Failed posts queue and retry (bounded, FIFO) so a network blip isn't a silent bypass.
const MAX_PENDING_REPORTS = 100;
const pendingReports = [];
let isFlushingReports = false;

/**
 * Attempts a single authenticated POST of one violation to the backend.
 * @returns {Promise<boolean>} true on success, false if it should be retried.
 */
async function postViolation(payload) {
  const token = getCurrentAccessToken();
  if (!token) {
    return false;
  } // no session token yet — keep queued for retry
  try {
    await axios.post(`${API_BASE_URL}/interview/violation`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });
    return true;
  } catch (err) {
    logger.warn(`[violation-report] post failed (will retry): ${err.message}`);
    return false;
  }
}

/**
 * Drains the pending-report queue in FIFO order. Stops on the first failure so
 * ordering is preserved and the remaining items are retried on the next flush
 * (triggered by the next violation or the heartbeat tick). Re-entrancy guarded.
 */
async function flushReports() {
  if (isFlushingReports) {
    return;
  }
  isFlushingReports = true;
  try {
    while (pendingReports.length > 0) {
      const ok = await postViolation(pendingReports[0]);
      if (!ok) {
        break;
      }
      pendingReports.shift();
    }
  } finally {
    isFlushingReports = false;
  }
}

/** Enqueues a violation for backend delivery and kicks off a flush. */
function reportViolationToBackend(payload) {
  pendingReports.push(payload);
  if (pendingReports.length > MAX_PENDING_REPORTS) {
    pendingReports.shift(); // bound memory — drop the oldest unsent report
  }
  flushReports().catch((e) => logger.warn(`[violation-report] flush error: ${e.message}`));
}

function startHeartbeat() {
  if (heartbeatInterval) {
    return;
  }
  heartbeatInterval = setInterval(async () => {
    try {
      const token = getCurrentAccessToken();
      if (!token) {
        return;
      }
      await axios.post(
        `${API_BASE_URL}/interview/heartbeat`,
        { timestamp: new Date().toISOString() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      );
      // Opportunistically retry any violations that failed to POST earlier.
      flushReports().catch(() => {});
    } catch (err) {
      logger.warn(`[heartbeat] failed: ${err.message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * One detection pass during the interview: gathers every signal, fails closed
 * on sustained indeterminate results and routes violations through sendViolation().
 * @param {Electron.BrowserWindow} win
 */
async function runDetectionTick(win) {
  const [hdmi, proc, agentStatus] = await Promise.all([
    detectHDMIWindows().catch((e) => ({ status: "indeterminate", reason: e.message })),
    checkProcesses().catch(() => ({ found: [], status: "indeterminate" })),
    fetchAgentStatus()
      .then(filterAgentStatus)
      .catch(() => null),
  ]);

  // An unreachable agent may have been killed, so reachability is also a tamper signal.
  const agentReachable = !!agentStatus;
  const found = proc.found || [];

  appendAuditEvent("scan", {
    hdmi: hdmi.detected,
    hdmiStatus: hdmi.status,
    processStatus: proc.status,
    blockedApps: found,
    agentReachable,
    agentThreatCount: agentStatus?.threats?.length ?? 0,
    agentDegraded: agentStatus?.degraded ?? null,
    physicalMonitors: agentStatus?.physical_monitors ?? null,
  });

  trackIndeterminate(win, "hdmi", "External display check", hdmi.status);
  trackIndeterminate(win, "process", "Blocked-process check", proc.status);
  // A degraded agent ran but some of its own checks errored, so it can't vouch either.
  trackIndeterminate(
    win,
    "agent",
    "Security agent deep scan (possible tamper)",
    !agentReachable || agentStatus.degraded === true ? "indeterminate" : "clear"
  );

  // A null monitor count means "unknown", never "no mirrored display".
  if (agentReachable) {
    const physicalCount = agentStatus.physical_monitors;
    trackIndeterminate(
      win,
      "mirror",
      "Duplicate-display check",
      physicalCount === null || physicalCount === undefined ? "indeterminate" : "clear"
    );
  }

  if (hdmi.detected) {
    sendViolation(win, hdmi.reason || "External display detected", "high", {
      code: CODE.EXTERNAL_DISPLAY,
      category: "hdmi",
    });
  } else if (agentReachable && agentStatus.physical_monitors > 1) {
    // One logical display but several physical panels: "Duplicate these displays".
    sendViolation(
      win,
      `Duplicate/mirrored display detected (${agentStatus.physical_monitors} physical monitors)`,
      "high",
      { code: CODE.MIRRORED_DISPLAY, category: "hdmi" }
    );
  }
  for (const { id, blockedApps } of blockedAppsByCategory(found)) {
    const apps = blockedApps.map((p) => getDisplayName(p));
    sendViolation(win, `Blocked application running during interview: ${apps.join(", ")}`, "high", {
      code: codeForProcessCategory(id),
      category: id,
      apps,
    });
  }
  if (agentReachable && !agentStatus.safe_to_proceed && agentStatus.threats?.length > 0) {
    appendAuditEvent("threats", {
      threats: agentStatus.threats.map((t) => ({
        type: t?.type,
        severity: t?.severity,
        detail: t?.detail,
      })),
    });
    for (const { code, threat, apps } of threatsByCode(agentStatus.threats)) {
      sendViolation(win, threatEvent(code, apps), threat.severity === "HIGH" ? "high" : "medium", {
        code,
        category: "agent",
        apps,
      });
    }
  }
}

/** The failing process-check cards, each with its blocked apps. */
function blockedAppsByCategory(found) {
  if (found.length === 0) {
    return [];
  }
  return mapProcesses({ status: "violation", details: { processes: found } }).filter(
    (v) => v.status === FAIL
  );
}

/**
 * One entry per distinct threat code. Its first HIGH threat (else its first)
 * supplies the event and severity; apps come from every threat with that code.
 */
function threatsByCode(threats) {
  const groups = new Map();
  for (const threat of threats.filter((t) => t && typeof t === "object")) {
    const code = codeForThreat(threat);
    const group = groups.get(code) ?? { code, threat, apps: [] };
    if (group.threat.severity !== "HIGH" && threat.severity === "HIGH") {
      group.threat = threat;
    }
    if (typeof threat.process === "string" && threat.process) {
      group.apps.push(getThreatDisplayName(threat));
    }
    groups.set(code, group);
  }
  return [...groups.values()];
}

/**
 * Starts the interview's live detection. The first tick runs right away so the
 * hand-off from the pre-interview guard leaves no unchecked gap.
 * @param {Electron.BrowserWindow} win
 */
function start(win) {
  if (detectionInterval && sessionWin === win) {
    return;
  }
  clearInterval(detectionInterval);
  detachSessionWin();
  isSessionActive = true;
  sessionWin = win;
  win?.webContents?.on("did-finish-load", redeliverUnacked);

  const tick = () =>
    runDetectionTick(win).catch((e) =>
      logger.warn("[systemChecks] detection tick error:", e.message)
    );
  detectionInterval = setInterval(tick, DETECTION_INTERVAL_MS);
  tick();

  stopWatchingStarts?.();
  stopWatchingStarts = onProcessStarted(({ name }) => {
    if (sessionWin === win && (isBlocked(name) || isBlocked(`${name}.app`))) {
      tickNow(tick);
    }
  });

  startHeartbeat();
}

/** A blocked app just started: tick now instead of waiting. Bursts share one extra tick. */
function tickNow(tick) {
  if (!isSessionActive) {
    return;
  }
  if (startedTick) {
    startedAgain = true;
    return;
  }
  invalidateProcessCache();
  startedTick = tick().finally(() => {
    startedTick = null;
    if (startedAgain) {
      startedAgain = false;
      tickNow(tick);
    }
  });
}

/**
 * @typedef {object} ViolationPayload
 * @property {string} id - acknowledge with this id
 * @property {string} code - a CODE from shared/violationCodes
 * @property {string|null} category - the check that raised it, when there is one
 * @property {string[]} apps - display names, possibly empty
 * @property {string} event - human-readable text, kept for older site builds
 * @property {"high"|"medium"} severity
 * @property {number} count - times this event has fired this session
 * @property {boolean} isHardBlock
 * @property {"electron"} source
 * @property {string} timestamp
 * @property {boolean} [redelivered] - a re-send of an unacknowledged violation
 */

/**
 * Pushes a violation to the interview site, which shows the warning or ends
 * the session (`window.electronAPI.onViolation()`).
 * @param {Electron.BrowserWindow} win
 * @param {ViolationPayload} payload
 */
function _pushViolationToRenderer(win, payload) {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    win.webContents.send(IPC.PUSH_VIOLATION, payload);
    logger.info("[systemChecks] violation pushed to renderer:", payload.code, payload.event);
  } catch (err) {
    logger.warn("[systemChecks] violation push failed:", err.message);
  }
}

function _appNames(apps) {
  return Array.isArray(apps) ? [...new Set(apps.filter((a) => typeof a === "string" && a))] : [];
}

/**
 * The single path for every interview violation: pushed to the site, posted to
 * the backend and held until the site acknowledges it.
 * Cooldown and escalation are keyed by `event`.
 * @param {Electron.BrowserWindow} win
 * @param {string} event
 * @param {"high"|"medium"} severity
 * @param {{code?: string, category?: string|null, apps?: string[]}} [meta]
 */
function sendViolation(win, event, severity, meta = {}) {
  if (!isSessionActive) {
    logger.info("[systemChecks] sendViolation suppressed — session no longer active");
    return;
  }

  const now = Date.now();
  if (violationCache.has(event) && now - violationCache.get(event) < VIOLATION_COOLDOWN_MS) {
    return;
  }
  violationCache.set(event, now);

  const count = (violationEscalation.get(event) || 0) + 1;
  violationEscalation.set(event, count);
  const code = isKnownCode(meta?.code) ? meta.code : CODE.SUSPICIOUS_ACTIVITY;
  const isHardBlock = !isStrikeCode(code) && (severity === "high" || count >= 2);

  /** @type {ViolationPayload} */
  const payload = {
    id: crypto.randomUUID(),
    code,
    category: typeof meta?.category === "string" ? meta.category : null,
    apps: _appNames(meta?.apps),
    event,
    severity,
    count,
    isHardBlock,
    source: "electron",
    timestamp: new Date(now).toISOString(),
  };

  appendAuditEvent("violation", payload);
  logger.warn(
    "[systemChecks] VIOLATION:",
    event,
    `| code: ${payload.code} | severity: ${severity} | count: ${count} | hardBlock: ${isHardBlock}`
  );

  holdUntilAcked(win, payload);
  _pushViolationToRenderer(win, payload);
  reportViolationToBackend(payload);
}

/**
 * An unacknowledged violation was probably missed (page still loading,
 * reloaded or down), so every one is kept and sent again, same id, on the next
 * page load. A hard block is also sent again once after the grace period. The
 * lockdown and detection stay on either way: only the site ending the
 * interview unlocks the window.
 */
function holdUntilAcked(win, payload) {
  unacked.set(payload.id, payload);
  if (unacked.size > MAX_UNACKED_VIOLATIONS) {
    _forget(unacked.keys().next().value);
  }
  if (!payload.isHardBlock || hardBlockTimer) {
    return;
  }
  hardBlockId = payload.id;
  hardBlockTimer = setTimeout(() => {
    const pending = unacked.get(hardBlockId);
    hardBlockTimer = null;
    hardBlockId = null;
    if (!isSessionActive || !pending) {
      return;
    }
    logger.warn(
      `[systemChecks] hard block not acknowledged, sending again (lockdown stays on): ${pending.event}`
    );
    _pushViolationToRenderer(win, { ...pending, redelivered: true });
  }, HARD_BLOCK_GRACE_MS);
}

function redeliverUnacked() {
  if (!isSessionActive || unacked.size === 0) {
    return;
  }
  logger.info(
    `[systemChecks] page loaded with ${unacked.size} unacknowledged violation(s) — sending again`
  );
  for (const payload of unacked.values()) {
    _pushViolationToRenderer(sessionWin, { ...payload, redelivered: true });
  }
}

function _forget(id) {
  unacked.delete(id);
  if (id === hardBlockId) {
    clearTimeout(hardBlockTimer);
    hardBlockTimer = null;
    hardBlockId = null;
  }
}

function clearUnacked() {
  clearTimeout(hardBlockTimer);
  hardBlockTimer = null;
  hardBlockId = null;
  unacked.clear();
}

/**
 * @param {string} [id] - without one, everything pending is acknowledged
 *   (site builds that predate ids)
 */
function acknowledgeViolation(id) {
  if (id) {
    _forget(id);
  } else {
    clearUnacked();
  }
}

// ─── Preflight ───────────────────────────────────────────────────────────────

/**
 * Resolves with `fallback` if `promise` rejects or doesn't settle within `ms`,
 * so one hung probe marks only its own card unverified. Never rejects.
 * Records duration and outcome into `timings[key]` when given.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @param {string} label - for the timeout log line
 * @param {{timings?: Record<string, object>, key?: string}} [record]
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, fallback, label, record = {}) {
  const startedAt = Date.now();
  const { timings, key } = record;
  const note = (outcome) => {
    if (!timings || !key) {
      return;
    }
    timings[key] = {
      durationMs: Date.now() - startedAt,
      deadlineMs: ms,
      outcome, // "ok" | "timeout" | "error"
      timedOut: outcome === "timeout",
    };
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`[preflight] ${label} exceeded ${ms}ms — reporting unverified`);
      note("timeout");
      resolve(fallback);
    }, ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => {
        // A late result must not overwrite the recorded timeout.
        if (!timings?.[key]) {
          note("ok");
        }
        return value;
      },
      (err) => {
        logger.warn(`[preflight] ${label} threw: ${err.message}`);
        if (!timings?.[key]) {
          note("error");
        }
        return fallback;
      }
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// Factories, not shared objects: a caller mutating a shared fallback would poison later scans.
const hdmiUnverified = () => ({
  detected: false,
  status: "indeterminate",
  monitors: [],
  reason: "",
});
const mirrorUnverified = () => ({
  detected: false,
  status: "indeterminate",
  details: { processes: [] },
});
const agentUnreachable = () => ({ alive: false, status: null });

/** Consecutive scans in which the agent was unreachable or returned nothing. */
let _agentFailStreak = 0;

/**
 * Fetches the agent's deep-scan result. Readiness is owned by agentManager; the
 * reserve at the end of the budget is for the scan itself.
 *
 * @param {number} [budgetMs]
 * @param {((phase: "starting"|"scanning") => void)} [onPhase] - progress only
 * @returns {Promise<{alive: boolean, status: object|null, blocked?: boolean}>}
 */
async function scanAgent(budgetMs = PREFLIGHT_AGENT_DEADLINE_MS, onPhase = null) {
  const startedAt = Date.now();
  const livenessBudget = budgetMs - PREFLIGHT_AGENT_SCAN_RESERVE_MS;

  // The readiness wait never replaces a live agent, so a hung one is restarted here.
  if (_agentFailStreak >= AGENT_RESTART_AFTER_FAILURES) {
    onPhase?.("starting");
    await restartAgent();
  } else if (!isAgentReady()) {
    onPhase?.("starting");
  }

  const alive = await whenAgentReady(Math.max(0, livenessBudget - (Date.now() - startedAt)));
  if (!alive) {
    return isAgentBlocked() ? { alive: false, status: null, blocked: true } : agentUnreachable();
  }

  onPhase?.("scanning");
  const status = await triggerAgentScan();
  return { alive: true, status: status && !status.error ? filterAgentStatus(status) : null };
}

/** Result of the most recent committed preflight pass. */
let _lastPreflight = null;

/** Threat PID → lowercase image name, from the latest agent scan that came back. */
let _threatProcesses = new Map();

function _rememberThreats(threats) {
  const map = new Map();
  for (const t of threats || []) {
    if (Number.isInteger(t?.pid) && t.pid > 0 && typeof t.process === "string" && t.process) {
      map.set(t.pid, t.process.toLowerCase());
    }
  }
  _threatProcesses = map;
}

/** @returns {Map<number, string>} */
function getThreatProcesses() {
  return new Map(_threatProcesses);
}

/** Scans currently running; each knows whether its page is still the current one. */
const _activeScans = new Set();

/**
 * Runs every preflight check concurrently, streaming each verdict through
 * `onProgress` as it lands, and returns the verdicts plus the gate.
 *
 * Only a scan whose `isCurrent()` is still true when it finishes may commit its
 * result; a scan whose page was left still completes and is logged.
 *
 * @param {((payload: object) => void) | null} onProgress
 * @param {{token?: string|null, isCurrent?: () => boolean}} [opts]
 * @returns {Promise<{token: string|null, scanId: string, verdicts: object[],
 *   canProceed: boolean, capturedAt: number, expiresAt: number, timings: object}>}
 */
async function runChecksOnce(onProgress = null, { token = null, isCurrent = () => true } = {}) {
  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const scan = { isCurrent };
  _activeScans.add(scan);
  // The monitor reads the same process list and drives the same page, so it pauses.
  _pauseMonitor();
  try {
    return await _runChecksOnceInner(onProgress, { scanId, token, isCurrent });
  } finally {
    _activeScans.delete(scan);
    if (_activeScans.size === 0) {
      _resumeMonitor();
    }
  }
}

async function _runChecksOnceInner(onProgress, { scanId, token, isCurrent }) {
  const startedAt = Date.now();
  /** @type {Record<string, {durationMs:number, deadlineMs:number, outcome:string, timedOut:boolean}>} */
  const timings = {};

  // The monitor keeps the 3s process cache warm; a Re-scan must not answer from it.
  invalidateProcessCache();

  const emit = (payload) => {
    try {
      onProgress?.({ ...payload, scanId, token });
    } catch {
      // Renderer went away mid-scan; the result is still logged.
    }
  };

  let firstProbeAt = null;
  const landed = () => {
    firstProbeAt ??= Date.now();
  };

  const hdmiPromise = withDeadline(
    detectHDMIWindows(),
    PREFLIGHT_HDMI_DEADLINE_MS,
    hdmiUnverified(),
    "display probe",
    { timings, key: "display" }
  );
  const mirrorPromise = withDeadline(
    detectMirroring(),
    PREFLIGHT_PROCESS_DEADLINE_MS,
    mirrorUnverified(),
    "process scan",
    { timings, key: "process" }
  );
  // Phase events carry no verdict, so an agent still booting can never reach the gate.
  const agentPromise = withDeadline(
    scanAgent(PREFLIGHT_AGENT_DEADLINE_MS, (phase) => emit({ id: "agent", phase })),
    PREFLIGHT_AGENT_DEADLINE_MS,
    agentUnreachable(),
    "agent deep scan",
    { timings, key: "agent" }
  );

  const hdmiSettled = hdmiPromise.then((raw) => {
    landed();
    emit(mapHdmi(raw));
    return raw;
  });
  const mirrorSettled = mirrorPromise.then((raw) => {
    landed();
    mapProcesses(raw).forEach(emit);
    return raw;
  });
  const agentSettled = agentPromise.then((raw) => {
    landed();
    emit(mapAgent(raw));
    return raw;
  });

  const [rawHdmi, mirror, agent] = await withDeadline(
    Promise.all([hdmiSettled, mirrorSettled, agentSettled]),
    PREFLIGHT_GLOBAL_DEADLINE_MS,
    [hdmiUnverified(), mirrorUnverified(), agentUnreachable()],
    "preflight pass",
    { timings, key: "overall" }
  );

  // The screen API sees logical displays only, so "Duplicate these displays"
  // reads as one. More physical panels than that means a mirrored screen. Only a
  // verified-clear probe is upgraded, and a null count never upgrades anything.
  const physical = agent?.status?.physical_monitors;
  const hdmi =
    !rawHdmi.detected && rawHdmi.status === "clear" && physical > 1
      ? {
          ...rawHdmi,
          detected: true,
          status: "violation",
          mirrored: true,
          count: physical,
          reason: `Duplicate/mirrored display detected (${physical} physical monitors)`,
        }
      : rawHdmi;

  const verdicts = buildVerdicts({ hdmi, mirror, agent });
  const proceed = canProceed(verdicts);
  const finishedAt = Date.now();
  const capturedAt = firstProbeAt ?? finishedAt;
  const expiresAt = capturedAt + PREFLIGHT_RESULT_MAX_AGE_MS;

  // Re-emit so a mirror upgrade replaces the card already drawn (cards are keyed by id).
  verdicts.forEach(emit);

  const committed = isCurrent();
  if (committed) {
    _agentFailStreak = agent?.alive && agent.status ? 0 : _agentFailStreak + 1;
    if (agent?.status) {
      _rememberThreats(agent.status.threats);
    }
    _lastPreflight = { scanId, canProceed: proceed, capturedAt };
    _live = null;
    preflightTelemetry.recordScan({
      scanId,
      capturedAt,
      canProceed: proceed,
      durationMs: finishedAt - startedAt,
      verdicts,
      timings,
      agentStatus: agent?.status,
    });
  }

  appendAuditEvent("scan", {
    phase: "preflight",
    scanId,
    committed,
    durationMs: finishedAt - startedAt,
    canProceed: proceed,
    timings,
    verdicts: verdicts.map((v) => ({ id: v.id, status: v.status, reason: v.reasonKey })),
    physicalMonitors: agent?.status?.physical_monitors ?? null,
    agentVersion: agent?.status?.agent_version ?? null,
    agentSourceSha: agent?.status?.source_sha ?? null,
    agentSourceExpected: expectedAgentSource(),
  });
  logger.info(
    `[preflight] scan ${scanId} finished in ${finishedAt - startedAt}ms — ` +
      `canProceed=${proceed}${committed ? "" : " (page left, not committed)"} ` +
      `[${verdicts.map((v) => `${v.id}:${v.status}`).join(" ")}] ` +
      `timings=[${formatTimings(timings)}]`
  );

  return { token, scanId, verdicts, canProceed: proceed, capturedAt, expiresAt, timings };
}

function formatTimings(timings) {
  return Object.entries(timings || {})
    .map(([key, t]) => `${key}:${t.durationMs}ms/${t.outcome}`)
    .join(" ");
}

/**
 * Authoritative check performed when leaving the security-check page. The
 * renderer enabling its button is UX only.
 *
 * @param {{requireFresh?: boolean}} [opts] - `requireFresh` (default true) also
 *   requires a recent pass, no running scan and a clean live monitor. Later
 *   stages pass false: by then the preflight is legitimately minutes old.
 * @returns {{ok: boolean, code: "none"|"failed"|"stale"|"dirty"|"scanning", reason: string}}
 */
function verifyProceedAllowed({ requireFresh = true } = {}) {
  if (requireFresh && [..._activeScans].some((s) => s.isCurrent())) {
    return { ok: false, code: "scanning", reason: "a preflight scan is still running" };
  }
  if (!_lastPreflight) {
    return { ok: false, code: "failed", reason: "no preflight has been run" };
  }
  if (!_lastPreflight.canProceed) {
    return { ok: false, code: "failed", reason: "last preflight did not pass" };
  }
  if (requireFresh) {
    if (_live && !_live.clean) {
      return {
        ok: false,
        code: "dirty",
        reason: _live.unverified
          ? "the live check could not verify the system"
          : "the live check found a blocked app or an extra display",
      };
    }
    const age = Date.now() - _lastPreflight.capturedAt;
    if (age > PREFLIGHT_RESULT_MAX_AGE_MS) {
      return {
        ok: false,
        code: "stale",
        reason: `preflight result is stale (${Math.round(age / 1000)}s old)`,
      };
    }
  }
  return { ok: true, code: "none", reason: "" };
}

/**
 * Renews a pass whose only problem is its age, with a quick fresh look at
 * processes, displays and the agent's latest status.
 * @param {number} [budgetMs]
 * @returns {Promise<boolean>} true if the pass was renewed
 */
async function renewStalePass(budgetMs = PREFLIGHT_REVERIFY_DEADLINE_MS) {
  if (verifyProceedAllowed().code !== "stale") {
    return false;
  }
  const pass = _lastPreflight;
  invalidateProcessCache();
  const [proc, hdmi, agent] = await withDeadline(
    Promise.all([
      checkProcesses(),
      detectHDMIWindows(),
      fetchAgentStatus().then(filterAgentStatus),
    ]),
    budgetMs,
    [null, null, null],
    "stale-pass re-check"
  );
  const clean =
    proc?.status === "clear" &&
    (proc.found || []).length === 0 &&
    hdmi?.status === "clear" &&
    !hdmi.detected &&
    !!agent &&
    !agent.error &&
    agent.degraded !== true &&
    !(agent.threats?.length > 0) &&
    !(agent.physical_monitors > 1);

  if (!clean || _lastPreflight !== pass) {
    logger.warn("[preflight] stale pass could not be renewed");
    return false;
  }
  _lastPreflight = { ...pass, capturedAt: Date.now() };
  appendAuditEvent("scan", { phase: "renew", scanId: pass.scanId });
  logger.info(`[preflight] stale pass ${pass.scanId} renewed`);
  return true;
}

function detachSessionWin() {
  if (sessionWin && !sessionWin.isDestroyed?.()) {
    sessionWin.webContents?.removeListener("did-finish-load", redeliverUnacked);
  }
  sessionWin = null;
}

function _endSession() {
  isSessionActive = false;
  indeterminateStreak.clear();
  clearUnacked();
  detachSessionWin();
  clearInterval(detectionInterval);
  detectionInterval = null;
  stopWatchingStarts?.();
  stopWatchingStarts = null;
  startedAgain = false;
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

/** Ends the interview's detection. Called when the site reports the interview is over. */
function stop() {
  _endSession();
  // The token is still valid right after the session, so try once more to post
  // anything still queued.
  flushReports().catch(() => {});
  logger.info("[systemChecks] detection stopped — session ended");
}

function resetState() {
  _endSession();
  _lastPreflight = null;
  _live = null;
  _threatProcesses = new Map();
  violationCache.clear();
  violationEscalation.clear();
  pendingReports.length = 0;
}

// ─── Pre-proceed monitor ─────────────────────────────────────────────────────
// Runs only while the security-check page is shown, re-checking processes and
// displays so the page (and the gate) notice an app opened after the scan.

/**
 * Turns one monitor tick's raw probes into the pushed payload.
 * @returns {{clean: boolean, unverified: boolean, apps: string[], verdicts: object[]}}
 */
function buildLiveStatus(hdmi, proc) {
  const apps = proc?.found || [];
  const verdicts = [
    mapHdmi(hdmi),
    ...mapProcesses({ status: proc?.status ?? "indeterminate", details: { processes: apps } }),
  ];
  return {
    clean: verdicts.every((v) => v.status === PASS),
    unverified: verdicts.some((v) => v.status === UNVERIFIED),
    apps,
    verdicts,
  };
}

async function _monitorTick() {
  const win = _preProceedWin;
  const epoch = _monitorEpoch;
  const seq = ++_tickSeq;
  if (!win || _activeScans.size > 0) {
    return;
  }
  try {
    const [proc, hdmi] = await Promise.all([
      checkProcesses().catch(() => ({ found: [], status: "indeterminate" })),
      detectHDMIWindows().catch(() => hdmiUnverified()),
    ]);
    // Drop a tick that outlived the monitor or lost the race to a newer one.
    if (epoch !== _monitorEpoch || seq < _appliedTickSeq || _activeScans.size > 0) {
      return;
    }
    _appliedTickSeq = seq;
    const payload = buildLiveStatus(hdmi, proc);
    _live = { clean: payload.clean, unverified: payload.unverified };
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PUSH_PRE_PROCEED_STATUS, payload);
    }
  } catch (e) {
    logger.warn("[systemChecks] pre-proceed monitor error:", e.message);
  }
}

function _screen() {
  try {
    const { screen } = require("electron");
    return screen && typeof screen.on === "function" ? screen : null;
  } catch {
    return null;
  }
}

function _onDisplayChange() {
  _monitorTick();
}

function _watchDisplays(on) {
  const screen = _screen();
  if (!screen) {
    return;
  }
  try {
    for (const event of ["display-added", "display-removed"]) {
      if (on) {
        screen.on(event, _onDisplayChange);
      } else {
        screen.removeListener(event, _onDisplayChange);
      }
    }
  } catch (e) {
    logger.warn("[systemChecks] display events unavailable:", e.message);
  }
}

function _haltMonitor() {
  clearInterval(preProceedInterval);
  preProceedInterval = null;
  _watchDisplays(false);
  _monitorEpoch += 1;
}

/**
 * Starts the live monitor for the security-check page. While a scan runs it is
 * deferred and starts when the scan finishes.
 * @param {Electron.BrowserWindow} win
 */
function startPreProceedMonitor(win) {
  _preProceedDesired = true;
  _preProceedWin = win;
  if (preProceedInterval || _activeScans.size > 0) {
    return;
  }
  logger.info("[systemChecks] pre-proceed monitor started");
  preProceedInterval = setInterval(_monitorTick, PRE_PROCEED_INTERVAL_MS);
  _watchDisplays(true);
}

/** Stops the monitor for good (page left) and forgets its live state. */
function stopPreProceedMonitor() {
  _preProceedDesired = false;
  _preProceedWin = null;
  _live = null;
  _haltMonitor();
  logger.info("[systemChecks] pre-proceed monitor stopped");
}

function _pauseMonitor() {
  if (preProceedInterval) {
    _haltMonitor();
    logger.info("[systemChecks] pre-proceed monitor paused for preflight scan");
  }
}

function _resumeMonitor() {
  const win = _preProceedWin;
  if (_preProceedDesired && win && !win.isDestroyed()) {
    startPreProceedMonitor(win);
  }
}

module.exports = {
  start,
  stop,
  sendViolation,
  resetState,
  runChecksOnce,
  /** True while an interview is live; refuses actions that show system UI mid-session. */
  isSessionActive: () => isSessionActive,
  verifyProceedAllowed,
  renewStalePass,
  getThreatProcesses,
  rememberThreats: _rememberThreats,
  recordAuditEvent: appendAuditEvent,
  getAuditLog,
  acknowledgeViolation,
  startPreProceedMonitor,
  stopPreProceedMonitor,
  _internal: {
    buildLiveStatus,
    runDetectionTick,
    monitorTick: _monitorTick,
    agentFailStreak: () => _agentFailStreak,
  },
};
