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
  AGENT_POLL_INTERVAL_MS,
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
const { pingAgent, fetchAgentStatus, triggerAgentScan } = require("./agentClient");
const logger = require("../main/logger");

const violationCache = new Map(); // event key → last-fired timestamp
const violationEscalation = new Map(); // event key → total fire count (ADD-06)

let isSessionActive = false;

// Phase 1: a single unified detection timer replaces the four overlapping
// intervals (hdmi+mirror / agent poll / anti-tamper / process watch) that each
// fired on their own schedule and pushed violations independently. One tick now
// gathers every signal, applies the fail-closed policy uniformly, and routes all
// violations through one path — removing duplicate timers and inter-tick races.
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
 * Records the outcome of a single check tick and escalates a sustained
 * inability-to-verify into a violation.
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

// ─── Backend violation reporting (Phase 3) ───────────────────────────────────
// Server-authoritative enforcement: every violation is POSTed to the backend in
// ADDITION to the renderer push. The renderer push is best-effort UX — if the
// page reloaded or its onViolation listener wasn't attached yet, that event is
// lost and the candidate faces no consequence. The backend POST makes the server
// the source of truth: it records the violation and can terminate / flag the
// session regardless of renderer state.
//
// Failed posts are queued and retried (bounded, FIFO) so a transient network
// blip is not a silent bypass.
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
 * One unified detection pass. Gathers every signal, applies the fail-closed
 * policy uniformly, and routes all violations through sendViolation().
 *
 * Phase 4: the live tick reads the process list ONCE via checkProcesses() and
 * emits a single de-duplicated process violation. The old code ran both
 * detectMirroring() AND a separate process watcher over the same blocked-app
 * list, so every running blocked app (e.g. chrome.exe) fired twice — once
 * "medium" (casting) and once "high". detectMirroring() is only used by the
 * preflight now (its renderer reads details.processes).
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
  // Agent down = indeterminate deep-scan. This replaces the old one-shot tamper
  // ping with the same N-strike model, so a single transient miss no longer
  // false-fires a "security agent terminated" violation.
  //
  // `degraded` (agent contract v2) means the agent ran but some of its own
  // checks errored, so it cannot vouch for the machine either. That is the same
  // "could not verify" condition as being unreachable and gets the same N-strike
  // treatment. An older agent build omits the field, which reads as not degraded.
  trackIndeterminate(
    win,
    "agent",
    "Security agent deep scan (possible tamper)",
    !agentReachable || agentStatus.degraded === true ? "indeterminate" : "clear"
  );

  // Duplicate-display cross-check. agent.py returns null when it could not read
  // the physical monitor count; 0 legitimately means "not applicable" (macOS /
  // Linux, where the screen API is authoritative). That null used to be coerced
  // by `|| 0` and compared as "no mirrored display" — a silent fail-OPEN during
  // a LIVE interview, where a candidate could mirror to a second panel and never
  // be flagged. Only tracked while the agent is reachable; an unreachable agent
  // already escalates under the "agent" key above.
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
 * also if it rejects. Never rejects itself.
 *
 * This is deliberately a RESOLVE-with-fallback rather than a reject: one slow
 * or broken probe must degrade its own card to "unverified", not abort the
 * whole scan. The old all-or-nothing behaviour is what produced the retry
 * storm — a single hung check left every card stuck on "Scanning".
 *
 * @template T
 * Also records how long the probe actually took and how it ended, into
 * `timings[key]` when a record sink is supplied (Phase E). Per-check durations
 * are the one piece of data that makes a "the security check didn't work"
 * report actionable — the original timeout bug was invisible precisely because
 * only the total was logged.
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
 * The happy path is now ONE round trip: a successful scan proves liveness, so
 * the separate ping beforehand was pure latency. We only fall back to a ping
 * when the scan fails, and then solely to tell "agent is dead" (fail — Re-scan
 * respawns it) apart from "agent is alive but its scan did not come back"
 * (unverified). Those two used to be indistinguishable, and the second one
 * rendered as a clean pass.
 *
 * @returns {Promise<{alive: boolean, status: object|null}>}
 */
async function scanAgent(budgetMs = PREFLIGHT_AGENT_DEADLINE_MS) {
  // WAIT for the agent to come up rather than asking once.
  //
  // sendAgentCommand() resolves null SYNCHRONOUSLY when no agent process exists
  // yet — it does not wait and does not time out. The agent is spawned by
  // prewarmAgent() as the security-check page opens, but spawning costs
  // killStaleAgent() (taskkill + a PowerShell probe, ~1.5-2.5s) plus a cold
  // PyInstaller unpack (2-5s). The preflight's agent probe runs milliseconds
  // after the page loads, so it used to get an instant "no agent" and report
  // "Security agent failed to start" — never once using its multi-second
  // budget. Clicking Re-scan then succeeded purely because the agent had
  // finished starting in the meantime, which is exactly the reported symptom.
  //
  // We now poll for liveness inside the budget, reserving time at the end for
  // the scan itself. A genuinely dead agent still fails, just at the deadline
  // instead of immediately.
  const deadline = Date.now() + budgetMs;
  const livenessDeadline = deadline - PREFLIGHT_AGENT_SCAN_RESERVE_MS;

  let alive = await pingAgent();
  while (!alive && Date.now() < livenessDeadline) {
    await new Promise((r) => setTimeout(r, AGENT_POLL_INTERVAL_MS));
    alive = await pingAgent();
  }

  if (!alive) {
    return { alive: false, status: null };
  }

  const status = await triggerAgentScan();
  return { alive: true, status: status && !status.error ? status : null };
}

/**
 * Runs every preflight check and returns the verdict list plus the authoritative
 * `canProceed` gate.
 *
 * Checks run CONCURRENTLY, each under its own deadline, and each verdict is
 * streamed to the renderer via `onProgress` the moment it lands. Previously the
 * three steps ran sequentially behind a single renderer-side timeout that was
 * shorter than their combined worst case, so a cold agent reliably aborted a
 * scan that was in fact progressing normally.
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
  const agentPromise = withDeadline(
    scanAgent(), PREFLIGHT_AGENT_DEADLINE_MS, agentUnreachable(), "agent deep scan",
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
  // card (the renderer keys cards by id, so a re-emit replaces the earlier one).
  //
  // Derived into a NEW object rather than mutated in place: rawHdmi may be a
  // timeout fallback, and an "unverified" result must never be upgradable into a
  // concrete verdict — if we could not read the displays at all, a physical
  // count from the agent does not tell us what the OS is doing with them.
  // No `|| 0` here: agent contract v2 returns null when the count could not be
  // read, and coercing that to 0 would read as "no mirrored display". `null > 1`
  // is false, so an unreadable count simply does not upgrade the verdict — and
  // the agent's own `degraded` flag independently marks its card unverified,
  // which keeps the gate closed rather than silently passing.
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
 * WHY PAUSE RATHER THAN LET THEM OVERLAP
 * ──────────────────────────────────────
 * The monitor polls checkProcesses() every 2s, which keeps that function's 3s
 * result cache permanently warm. runChecksOnce() calls invalidateProcessCache()
 * at scan start, but the monitor could refill it a fraction of a second later,
 * so the scan's own detectMirroring() would read a snapshot the MONITOR took —
 * possibly from before the candidate closed the offending app. The monitor also
 * pushes PUSH_PRE_PROCEED_STATUS, which drives the same Proceed button and
 * status line the scan is in the middle of repainting.
 *
 * Pausing is the simplest fix that removes both problems at once: while a scan
 * owns the screen there is nothing for a 2s poller to contribute — the scan is
 * reading the very same process list, only more thoroughly. The alternative
 * (letting both run and having the scan bypass the cache) leaves the UI race
 * unaddressed and needs a second, cache-bypassing code path.
 *
 * Resume restores only what the flow actually WANTS running: if no monitor was
 * active (the normal case for the FIRST scan, which runs before ipcHandlers
 * ever starts one) or the user stopped it mid-scan via Proceed/Recheck, resume
 * is a no-op rather than starting one behind the flow's back.
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
