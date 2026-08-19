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
} = require("../shared/constants");
const { getCurrentAccessToken } = require("../main/protocolHandler");
const axios = require("axios");
const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { checkProcesses, invalidateProcessCache } = require("./mirrorDetector");
const {
  mapHdmi,
  mapProcesses,
  mapAgent,
  buildVerdicts,
  canProceed,
} = require("./preflightVerdict");
const { getDisplayName } = require("../shared/appList");
const { fetchAgentStatus, triggerAgentScan } = require("./agentClient");
const { whenAgentReady, isAgentReady } = require("../main/agentManager");
const logger = require("../main/logger");

const violationCache = new Map(); // event key → last-fired timestamp
const violationEscalation = new Map(); // event key → total fire count (ADD-06)

let isSessionActive = false;

// One unified detection timer replaces the old four overlapping intervals
// (hdmi+mirror / agent poll / anti-tamper / process watch), which each pushed
// violations independently and could race each other.
let detectionInterval = null;
let preProceedInterval = null;
let heartbeatInterval = null;
let hardBlockFailsafeTimer = null; // one-shot self-enforcement timer (Phase 3 follow-up)
let lastViolationAckAt = 0; // ms timestamp of the renderer's most recent ack

// ─── Pre-proceed monitor ↔ preflight scan mutual exclusion (Phase C) ──────────
// The monitor and a preflight scan read the SAME process list and drive the SAME
// Proceed button, so they must never run at once. See pausePreProceedMonitor().
let _preProceedWin = null;       // window the monitor pushes to, for resume
let _preProceedDesired = false;  // flow WANTS the monitor running (vs. paused)
let _scanInProgress = false;     // a preflight scan currently owns the screen

/**
 * Result of the most recent preflight pass, used to re-verify the gate in the
 * main process before lockdown. The renderer enabling its own Proceed button is
 * UX only — it must never be the thing that authorises entering the interview.
 * @type {{scanId: string, canProceed: boolean, capturedAt: number} | null}
 */
let _lastPreflight = null;

/**
 * Fail-CLOSED bookkeeping: counts consecutive "indeterminate" results per check
 * key during an active session. A check that errors/times out cannot confirm the
 * system is clean, so after INDETERMINATE_ESCALATION_THRESHOLD consecutive
 * failures we escalate to a violation instead of silently passing.
 */
const indeterminateStreak = new Map(); // check key → consecutive indeterminate count

/**
 * Records one check's outcome and escalates a sustained inability-to-verify
 * into a violation.
 * @param {Electron.BrowserWindow} win
 * @param {string} key   - stable check identifier, e.g. "hdmi" / "process"
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
  logger.warn(`[systemChecks] ${label} indeterminate (${streak}/${INDETERMINATE_ESCALATION_THRESHOLD})`);
  if (streak >= INDETERMINATE_ESCALATION_THRESHOLD) {
    sendViolation(
      win,
      `${label} could not be verified for ${streak} consecutive scans — possible tampering`,
      "high"
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
// the renderer push is best-effort UX and is lost if the page reloaded or its
// listener wasn't attached, so the backend POST is what makes the server the
// authority that can actually terminate/flag the session. Failed posts queue and
// retry (bounded, FIFO) so a network blip isn't a silent bypass.
const MAX_PENDING_REPORTS = 100;
const pendingReports = [];
let isFlushingReports = false;

/**
 * Attempts a single authenticated POST of one violation to the backend.
 * @returns {Promise<boolean>} true on success, false if it should be retried.
 */
async function postViolation(payload) {
  const token = getCurrentAccessToken();
  if (!token) { return false; } // no session token yet — keep queued for retry
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
  if (isFlushingReports) { return; }
  isFlushingReports = true;
  try {
    while (pendingReports.length > 0) {
      const ok = await postViolation(pendingReports[0]);
      if (!ok) { break; }
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
  if (heartbeatInterval) {return;}
  heartbeatInterval = setInterval(async () => {
    try {
      const token = getCurrentAccessToken();
      if (!token) {return;}
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
 * One unified detection pass: gathers every signal, applies fail-closed policy
 * uniformly, and routes all violations through sendViolation().
 *
 * Reads the process list ONCE via checkProcesses() and emits a single
 * de-duplicated violation — the old code also ran detectMirroring() over the
 * same blocked-app list, so a running blocked app fired twice ("medium" casting
 * + "high"). detectMirroring() is now only used by the preflight.
 *
 * @param {Electron.BrowserWindow} win
 */
async function runDetectionTick(win) {
  const [hdmi, proc, agentStatus] = await Promise.all([
    detectHDMIWindows().catch((e) => ({ status: "indeterminate", reason: e.message })),
    checkProcesses().catch(() => ({ found: [], status: "indeterminate" })),
    fetchAgentStatus().catch(() => null),
  ]);

  // Agent reachability doubles as the anti-tamper liveness signal: a null
  // response means the agent is unreachable (killed / crashed / blocked).
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

  // ── Fail-CLOSED: sustained inability to verify any signal escalates ──────────
  trackIndeterminate(win, "hdmi", "External display check", hdmi.status);
  trackIndeterminate(win, "process", "Blocked-process check", proc.status);
  // Agent down = indeterminate deep-scan, same N-strike model as the other
  // checks, so a single transient miss doesn't false-fire "agent terminated".
  // `degraded` (agent contract v2) means the agent ran but some of its own
  // checks errored, so it can't vouch for the machine either — same treatment.
  // Older agent builds omit the field, which reads as not degraded.
  trackIndeterminate(
    win,
    "agent",
    "Security agent deep scan (possible tamper)",
    !agentReachable || agentStatus.degraded === true ? "indeterminate" : "clear"
  );

  // Duplicate-display cross-check. agent.py returns null (not 0) when it can't
  // read the physical monitor count; coercing that to 0 would read as "no
  // mirrored display" — a silent fail-open. Only tracked while reachable; an
  // unreachable agent already escalates under the "agent" key above.
  if (agentReachable) {
    const physicalCount = agentStatus.physical_monitors;
    trackIndeterminate(
      win,
      "mirror",
      "Duplicate-display check",
      physicalCount === null || physicalCount === undefined ? "indeterminate" : "clear"
    );
  }

  // ── Positive detections ──────────────────────────────────────────────────────
  if (hdmi.detected) {
    sendViolation(win, hdmi.reason || "External display detected", "high");
  } else if (agentReachable && agentStatus.physical_monitors > 1) {
    // Screen API saw one logical display but the agent counted multiple physical
    // panels → "Duplicate these displays" mode (mirror to projector/second screen).
    sendViolation(
      win,
      `Duplicate/mirrored display detected (${agentStatus.physical_monitors} physical monitors)`,
      "high"
    );
  }
  // Single de-duplicated process violation (friendly names where known).
  if (found.length > 0) {
    const names = found.map((p) => getDisplayName(p)).join(", ");
    sendViolation(win, `Blocked application running during interview: ${names}`, "high");
  }
  if (agentReachable && !agentStatus.safe_to_proceed && agentStatus.threats?.length > 0) {
    const threat = agentStatus.threats[0];
    sendViolation(
      win,
      threat.detail || "Behavioral threat detected",
      threat.severity === "HIGH" ? "high" : "medium"
    );
  }
}

//  INTERVIEW MONITOR (single unified tick during active interview)
function start(win) {
  isSessionActive = true; // enable violation push

  detectionInterval = setInterval(() => {
    runDetectionTick(win).catch((e) =>
      logger.warn("[systemChecks] detection tick error:", e.message)
    );
  }, DETECTION_INTERVAL_MS);

  startHeartbeat();
}

/**
 * VIOLATION HANDLER:
 * Pushes a violation payload to the renderer (interview.letshyre.com) via IPC.
 * The website receives this on `window.electronAPI.onViolation()` and handles
 * its own UX — warning toasts for soft blocks, termination for hard blocks.
 *
 * @param {Electron.BrowserWindow} win
 * @param {{ event: string, severity: string, count: number, isHardBlock: boolean }} payload
 */
function _pushViolationToRenderer(win, payload) {
  try {
    win.webContents.send(IPC.PUSH_VIOLATION, {
      ...payload,
      source: "electron",
      timestamp: new Date().toISOString(),
    });
    logger.info("[systemChecks] violation pushed to renderer:", payload.event);
  } catch (err) {
    logger.warn("[systemChecks] violation push failed:", err.message);
  }
}

async function sendViolation(win, event, severity) {
  // Guard: never push violations after the session has ended.
  // stop() sets isSessionActive = false — any in-flight interval tick is dropped.
  if (!isSessionActive) {
    logger.info("[systemChecks] sendViolation suppressed — session no longer active");
    return;
  }

  const now = Date.now();

  if (violationCache.has(event)) {
    if (now - violationCache.get(event) < VIOLATION_COOLDOWN_MS) {
      return;
    }
  }
  violationCache.set(event, now);

  const prevCount = violationEscalation.get(event) || 0;
  const count = prevCount + 1;
  violationEscalation.set(event, count);

  const isHardBlock = severity === "high" || count >= 2;

  appendAuditEvent("violation", { event, severity, count, isHardBlock });
  logger.warn(
    "[systemChecks] VIOLATION:",
    event,
    `| severity: ${severity} | count: ${count} | hardBlock: ${isHardBlock}`
  );

  const payload = {
    event,
    severity,
    count,
    isHardBlock,
    source: "electron",
    timestamp: new Date().toISOString(),
  };

  // 1. Best-effort renderer push (immediate in-session UX).
  if (win) {
    _pushViolationToRenderer(win, { event, severity, count, isHardBlock });
  }

  // 2. Authoritative backend report (durable, retried) — Phase 3.
  reportViolationToBackend(payload);

  // 3. Self-enforcement failsafe — if this is a hard block and the website does
  //    not terminate within the grace window, Electron enforces it locally.
  if (isHardBlock) {
    armHardBlockFailsafe(event);
  }
}

/**
 * Arms the one-shot self-enforcement timer. If the session is still active when
 * it fires (the website didn't call interviewComplete), Electron lifts the
 * lockdown and shows the local violation screen, then halts detection. A no-op
 * if already armed — the first hard block wins.
 * @param {string} reason
 */
function armHardBlockFailsafe(reason) {
  if (hardBlockFailsafeTimer) { return; }
  const armedAt = Date.now();
  hardBlockFailsafeTimer = setTimeout(() => {
    hardBlockFailsafeTimer = null;
    if (!isSessionActive) { return; } // website already terminated the session

    // If the renderer acknowledged a violation during the grace window, the
    // website is alive and owns the warning/termination UX — do NOT override it.
    if (lastViolationAckAt >= armedAt) {
      logger.info("[systemChecks] violation acked by renderer — self-enforcement skipped");
      return;
    }

    logger.warn("[systemChecks] hard-block failsafe fired (no renderer ack) — self-enforcing locally");
    try {
      require("../main/windowManager").enforceViolation(reason);
    } catch (err) {
      logger.warn("[systemChecks] self-enforcement failed:", err.message);
    }
    stop(); // session is over — halt all detection loops
  }, HARD_BLOCK_GRACE_MS);
}

/**
 * Records a renderer acknowledgement. Called via IPC when the website confirms
 * it received and is handling a violation. Keeps the self-enforcement failsafe
 * suppressed while the renderer stays responsive.
 */
function acknowledgeViolation() {
  lastViolationAckAt = Date.now();
}

//PREFLIGHT: run all checks concurrently under per-check deadlines
/**
 * Resolves `promise` with `fallback` if it does not settle within `ms`, and
 * also if it rejects. Never rejects itself — one slow/broken probe degrades its
 * own card to "unverified" instead of aborting the whole scan (a single hung
 * check used to leave every card stuck on "Scanning").
 *
 * Also records duration/outcome into `timings[key]` when a record sink is
 * supplied, so a timed-out card can be told apart from an errored one.
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
    if (!timings || !key) { return; }
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
        // A probe that resolves after its deadline already fired must not
        // overwrite the recorded "timeout" outcome with a late "ok".
        if (!timings?.[key]) { note("ok"); }
        return value;
      },
      (err) => {
        logger.warn(`[preflight] ${label} threw: ${err.message}`);
        if (!timings?.[key]) { note("error"); }
        return fallback;
      }
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// "Could not verify" sentinels. These are FACTORIES, not shared constants: a
// shared object handed out as a timeout fallback can be mutated by a caller and
// then silently poisons every later scan in the process. Each call gets its own.
const hdmiUnverified = () => ({ detected: false, status: "indeterminate", monitors: [], reason: "" });
const mirrorUnverified = () => ({ detected: false, status: "indeterminate", details: { processes: [] } });
const agentUnreachable = () => ({ alive: false, status: null });

/**
 * Fetches the agent's deep-scan result.
 *
 * Happy path is one round trip: a successful scan proves liveness, so a
 * separate ping first would be pure latency. We only ping as a fallback when
 * the scan fails, to tell "agent is dead" (Re-scan respawns it) apart from
 * "agent alive but scan didn't come back" (unverified) — those used to be
 * indistinguishable, with the second one rendering as a clean pass.
 *
 * @param {number} [budgetMs]
 * @param {((phase: "starting"|"scanning") => void)} [onPhase] - progress only;
 *        reports which half of the budget we are in so the card can say
 *        "starting" instead of implying the scan is already running.
 * @returns {Promise<{alive: boolean, status: object|null}>}
 */
async function scanAgent(budgetMs = PREFLIGHT_AGENT_DEADLINE_MS, onPhase = null) {
  // Liveness is owned by agentManager (ready event, with a ping poll for older
  // agent binaries). Polling here independently used to race the pre-warm and
  // report a false "failed to start" while the agent was still booting. The
  // rest of the budget is reserved for the deep scan itself; a genuinely dead
  // agent still fails, just at the deadline instead of instantly.
  const livenessBudget = budgetMs - PREFLIGHT_AGENT_SCAN_RESERVE_MS;

  // A cold spawn is the one wait long enough to need explaining. Only announce
  // it when the agent genuinely isn't up — on the warm path both phases would
  // land in the same tick and the card would flicker for nothing.
  if (!isAgentReady()) {
    onPhase?.("starting");
  }

  const alive = await whenAgentReady(livenessBudget);

  if (!alive) {
    return { alive: false, status: null };
  }

  onPhase?.("scanning");
  const status = await triggerAgentScan();
  return { alive: true, status: status && !status.error ? status : null };
}

/**
 * Runs every preflight check and returns the verdict list plus the authoritative
 * `canProceed` gate.
 *
 * Checks run concurrently, each under its own deadline, streaming each verdict
 * to the renderer via `onProgress` as it lands. (They used to run sequentially
 * behind one renderer-side timeout shorter than their combined worst case, so a
 * cold agent reliably aborted an otherwise-healthy scan.)
 *
 * @param {((verdict: object) => void) | null} onProgress - called once per verdict
 * @returns {Promise<{scanId: string, verdicts: object[], canProceed: boolean,
 *                    capturedAt: number, timings: object}>}
 */
async function runChecksOnce(onProgress = null) {
  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  /** @type {Record<string, {durationMs:number, deadlineMs:number, outcome:string, timedOut:boolean}>} */
  const timings = {};

  // Phase C: the pre-proceed monitor must not run concurrently with a scan.
  // Pausing it here (and resuming in the finally below) stops it spawning
  // tasklist mid-scan and stops its PUSH_PRE_PROCEED_STATUS messages fighting
  // the scan's own card rendering.
  const resumeMonitor = pausePreProceedMonitor();

  try {
    return await _runChecksOnceInner(onProgress, scanId, startedAt, timings);
  } finally {
    // Restores the monitor even when a probe throws all the way out, so a failed
    // scan can never leave the success screen without its live gating.
    resumeMonitor();
  }
}

/**
 * The scan body. Split out so runChecksOnce() can wrap it in the monitor
 * pause/resume without an extra level of indentation.
 */
async function _runChecksOnceInner(onProgress, scanId, startedAt, timings) {
  // Always scan a fresh process list. The pre-proceed watcher polls every 2s and
  // keeps checkProcesses' 3s cache permanently warm, so without this a Re-scan
  // could answer from a snapshot taken before the candidate closed the app.
  // The monitor is paused above, and invalidateProcessCache() additionally
  // discards any probe it left in flight (see mirrorDetector's cache epoch), so
  // the reads below are guaranteed uncached.
  invalidateProcessCache();

  const emit = (verdict) => {
    try {
      onProgress?.({ ...verdict, scanId });
    } catch {
      // Renderer went away mid-scan — keep scanning, the result is still logged.
    }
  };

  // Kick all three probes off together.
  const hdmiPromise = withDeadline(
    detectHDMIWindows(), PREFLIGHT_HDMI_DEADLINE_MS, hdmiUnverified(), "display probe",
    { timings, key: "display" }
  );
  const mirrorPromise = withDeadline(
    detectMirroring(), PREFLIGHT_PROCESS_DEADLINE_MS, mirrorUnverified(), "process scan",
    { timings, key: "process" }
  );
  // `phase` events carry no verdict — they only repaint the pending card while
  // the agent boots. Deliberately not a status: an in-progress agent must never
  // be able to reach the gate, and the fail-closed timeout fallback below is
  // still what decides the card if the agent never arrives.
  const agentPromise = withDeadline(
    scanAgent(PREFLIGHT_AGENT_DEADLINE_MS, (phase) => emit({ id: "agent", phase })),
    PREFLIGHT_AGENT_DEADLINE_MS, agentUnreachable(), "agent deep scan",
    { timings, key: "agent" }
  );

  // Stream each card as soon as its own probe lands, rather than waiting for
  // the slowest one.
  const hdmiSettled = hdmiPromise.then((raw) => {
    emit(mapHdmi(raw));
    return raw;
  });
  const mirrorSettled = mirrorPromise.then((raw) => {
    mapProcesses(raw).forEach(emit);
    return raw;
  });
  const agentSettled = agentPromise.then((raw) => {
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

  // Cross-check (needs both probes): the screen API only sees LOGICAL displays,
  // so Windows "Duplicate these displays" mode reads as a single display. If the
  // agent counted more physical panels, upgrade the HDMI result and re-emit the
  // card (renderer keys cards by id, so re-emit replaces the earlier one).
  //
  // Built as a new object, not mutated in place: rawHdmi may be a timeout
  // fallback, and an "unverified" result must never get upgraded to a concrete
  // verdict from data (physical count) that doesn't actually confirm it.
  // No `|| 0` on physical_monitors: agent contract v2 returns null (not 0) when
  // unreadable, and `null > 1` is false, so an unreadable count just doesn't
  // upgrade the verdict — the agent's own `degraded` flag independently keeps
  // its card, and the gate, from silently passing.
  const physical = agent?.status?.physical_monitors;
  const hdmi =
    !rawHdmi.detected && rawHdmi.status === "clear" && physical > 1
      ? {
          ...rawHdmi,
          detected: true,
          status: "violation",
          reason: `Duplicate/mirrored display detected (${physical} physical monitors)`,
        }
      : rawHdmi;

  const verdicts = buildVerdicts({ hdmi, mirror, agent });
  const proceed = canProceed(verdicts);
  const capturedAt = Date.now();

  // Re-emit so a cross-check upgrade reaches a renderer that already drew the
  // streamed version. Idempotent by card id.
  verdicts.forEach(emit);

  appendAuditEvent("scan", {
    phase: "preflight",
    scanId,
    durationMs: capturedAt - startedAt,
    canProceed: proceed,
    // Per-probe duration + whether it hit its deadline. This is what turns
    // "the security check didn't work" into a diagnosable report: a card that
    // reads "unverified" because its probe blew a 8000ms budget looks nothing
    // like one that returned an error in 40ms, but the verdict is identical.
    timings,
    verdicts: verdicts.map((v) => ({ id: v.id, status: v.status, reason: v.reasonKey })),
    physicalMonitors: agent?.status?.physical_monitors ?? null,
    agentVersion: agent?.status?.agent_version ?? null,
  });
  logger.info(
    `[preflight] scan ${scanId} finished in ${capturedAt - startedAt}ms — ` +
      `canProceed=${proceed} [${verdicts.map((v) => `${v.id}:${v.status}`).join(" ")}] ` +
      `timings=[${formatTimings(timings)}]`
  );

  _lastPreflight = { scanId, canProceed: proceed, capturedAt };
  return { scanId, verdicts, canProceed: proceed, capturedAt, timings };
}

/** Renders the per-check timing map as a compact one-line log fragment. */
function formatTimings(timings) {
  return Object.entries(timings || {})
    .map(([key, t]) => `${key}:${t.durationMs}ms/${t.outcome}`)
    .join(" ");
}

/**
 * Authoritative check performed when leaving the security-check page.
 *
 * @param {{requireFresh?: boolean}} [opts] - `requireFresh` (default true) also
 *   requires the pass to be recent. Use false for later stages of the flow,
 *   where the preflight is legitimately minutes old by the time it is consulted.
 * @returns {{ok: boolean, reason: string}}
 */
function verifyProceedAllowed({ requireFresh = true } = {}) {
  if (!_lastPreflight) {
    return { ok: false, reason: "no preflight has been run" };
  }
  if (!_lastPreflight.canProceed) {
    return { ok: false, reason: "last preflight did not pass" };
  }
  if (requireFresh) {
    const age = Date.now() - _lastPreflight.capturedAt;
    if (age > PREFLIGHT_RESULT_MAX_AGE_MS) {
      return { ok: false, reason: `preflight result is stale (${Math.round(age / 1000)}s old)` };
    }
  }
  return { ok: true, reason: "" };
}

//  STOP (called when interview session ends)
/**
 * Stops all detection intervals and disables the violation push guard.
 * Called by ipcHandlers when INTERVIEW_COMPLETE is received from the website.
 * After this, sendViolation() is a no-op so no stale violations reach the site.
 */
function stop() {
  isSessionActive = false;
  indeterminateStreak.clear();
  clearTimeout(hardBlockFailsafeTimer);
  hardBlockFailsafeTimer = null;

  // Final delivery attempt for any violations not yet POSTed — the access token
  // is still valid immediately after the session ends. Fire-and-forget; the queue
  // is not cleared here so stragglers can still drain.
  flushReports().catch(() => {});

  clearInterval(detectionInterval);
  detectionInterval = null;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  logger.info("[systemChecks] detection stopped — session ended");
}

//  RESET (called when user hits "Recheck System")
function resetState() {
  isSessionActive = false;
  _lastPreflight = null; // a new scan must re-establish the Proceed gate
  violationCache.clear();
  violationEscalation.clear();
  indeterminateStreak.clear();
  pendingReports.length = 0; // new-session boundary — drop any stale unsent reports
  clearTimeout(hardBlockFailsafeTimer);
  hardBlockFailsafeTimer = null;

  clearInterval(detectionInterval);
  detectionInterval = null;
}

// ─── PRE-PROCEED MONITOR ─────────────────────────────────────────────────────

/**
 * Starts a lightweight background poller that runs checkProcesses() every 2s
 * and pushes the result to the preflight renderer via PUSH_PRE_PROCEED_STATUS.
 * This keeps the Proceed button state accurate in real-time without any blocking
 * scan at click-time.
 *
 * Call after preflight passes. Stopped when the user clicks Proceed or Recheck.
 *
 * @param {Electron.BrowserWindow} win
 */
function startPreProceedMonitor(win) {
  _preProceedDesired = true;
  _preProceedWin = win;
  if (preProceedInterval) {return;} // already running
  // A scan owns the process list and the screen right now; the resume hook
  // installed by pausePreProceedMonitor() will start us when it finishes.
  if (_scanInProgress) {
    logger.info("[systemChecks] pre-proceed monitor deferred — preflight scan in progress");
    return;
  }
  logger.info("[systemChecks] pre-proceed monitor started");
  preProceedInterval = setInterval(async () => {
    // Belt-and-braces with pausePreProceedMonitor(): a tick already queued when
    // the pause happened must not spawn tasklist or push a status mid-scan.
    if (_scanInProgress) { return; }
    try {
      const { found } = await checkProcesses();
      if (_scanInProgress) { return; } // a scan started while we were probing
      const payload = { clean: found.length === 0, apps: found };
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PUSH_PRE_PROCEED_STATUS, payload);
      }
    } catch (e) {
      logger.warn("[systemChecks] pre-proceed monitor error:", e.message);
    }
  }, 2000);
}

/**
 * Stops the pre-proceed watcher. Call when the user clicks Proceed or Recheck.
 */
function stopPreProceedMonitor() {
  // Clears the DESIRED state too, so a scan's resume hook cannot revive a
  // monitor the user explicitly stopped (Proceed / Recheck) mid-scan.
  _preProceedDesired = false;
  _preProceedWin = null;
  clearInterval(preProceedInterval);
  preProceedInterval = null;
  logger.info("[systemChecks] pre-proceed monitor stopped");
}

/**
 * Suspends the pre-proceed watcher for the duration of a preflight scan and
 * returns the resume function.
 *
 * Must pause, not overlap: the monitor's 2s poll keeps checkProcesses' 3s cache
 * warm, so it could refill the cache right after the scan invalidates it,
 * making the scan read a stale snapshot from before the candidate closed an
 * app. It also pushes PUSH_PRE_PROCEED_STATUS, fighting the scan for the same
 * Proceed button/status line. Pausing sidesteps both — the scan already reads
 * the same process list, more thoroughly, so the poller has nothing to add
 * while it runs.
 *
 * Resume only restores what the flow actually wants running: if no monitor was
 * active (normal for the first scan, before ipcHandlers starts one) or the
 * user stopped it mid-scan via Proceed/Recheck, resume is a no-op.
 *
 * @returns {() => void} resume — idempotent; call from a finally.
 */
function pausePreProceedMonitor() {
  _scanInProgress = true;

  if (preProceedInterval) {
    clearInterval(preProceedInterval);
    preProceedInterval = null;
    logger.info("[systemChecks] pre-proceed monitor paused for preflight scan");
  }

  let resumed = false;
  return function resumePreProceedMonitor() {
    if (resumed) { return; }
    resumed = true;
    _scanInProgress = false;
    const win = _preProceedWin;
    if (_preProceedDesired && win && !win.isDestroyed()) {
      startPreProceedMonitor(win);
    }
  };
}

module.exports = {
  start,
  stop,
  sendViolation,
  resetState,
  runChecksOnce,
  /** True while an interview is live. Used to refuse actions that show system
   *  UI (e.g. the elevated-kill consent prompt) during a proctored session. */
  isSessionActive: () => isSessionActive,
  verifyProceedAllowed,
  getAuditLog,
  acknowledgeViolation,
  startPreProceedMonitor,
  stopPreProceedMonitor,
};
