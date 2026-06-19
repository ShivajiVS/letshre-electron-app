const {
  IPC,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  INDETERMINATE_ESCALATION_THRESHOLD,
  API_BASE_URL,
} = require("../shared/constants");
const { getCurrentAccessToken } = require("../main/protocolHandler");
const axios = require("axios");
const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { checkProcesses } = require("./mirrorDetector");
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
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    try {
      const token = getCurrentAccessToken();
      if (!token) return;
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
  });

  // ── Fail-CLOSED: sustained inability to verify any signal escalates ──────────
  trackIndeterminate(win, "hdmi", "External display check", hdmi.status);
  trackIndeterminate(win, "process", "Blocked-process check", proc.status);
  // Agent down = indeterminate deep-scan. This replaces the old one-shot tamper
  // ping with the same N-strike model, so a single transient miss no longer
  // false-fires a "security agent terminated" violation.
  trackIndeterminate(
    win,
    "agent",
    "Security agent deep scan (possible tamper)",
    agentReachable ? "clear" : "indeterminate"
  );

  // ── Positive detections ──────────────────────────────────────────────────────
  if (hdmi.detected) {
    sendViolation(win, hdmi.reason || "External display detected", "high");
  } else if (agentReachable && (agentStatus.physical_monitors || 0) > 1) {
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

  //Cooldown gate
  if (violationCache.has(event)) {
    if (now - violationCache.get(event) < VIOLATION_COOLDOWN_MS) {
      return;
    }
  }
  violationCache.set(event, now);

  //Escalation tracking (ADD-06)
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
}

//PREFLIGHT: run all checks once and stream per-step progress
/**
 * Runs all preflight security checks and returns a combined result.
 *
 * ADD-02 — Streaming: if `onProgress` is provided, it is called twice per step:
 *   1. { step, status: 'running' } — check is starting
 *   2. { step, status: 'done', result } — check is complete with its result
 *
 * Steps run sequentially so each card in the UI can update as soon as its
 * check finishes, creating a left-to-right waterfall feel.
 *
 * @param {((step: string, status: string, result: any) => void) | null} onProgress
 */
async function runChecksOnce(onProgress = null) {
  const emit = (step, status, result = null) => onProgress?.(step, status, result);

  // ── Step 1: HDMI / external display check
  emit("hdmi", "running");
  const hdmi = await detectHDMIWindows();
  emit("hdmi", "done", hdmi);

  // ── Step 2: Mirror / blocked-process scan
  emit("mirror", "running");
  const mirror = await detectMirroring();
  emit("mirror", "done", mirror);

  // ── Step 3: Security agent deep scan
  emit("agent", "running");
  const agentAlive = await pingAgent();
  const agentStatus = agentAlive ? await triggerAgentScan() : null;
  emit("agent", "done", { alive: agentAlive, status: agentStatus });

  // Cross-check: the screen API only sees logical displays, so "Duplicate"
  // mode reads as a single display. If the agent counted >1 physical monitor,
  // fold that into the HDMI result so Proceed is blocked, and re-emit the card.
  if (!hdmi.detected && agentStatus && (agentStatus.physical_monitors || 0) > 1) {
    hdmi.detected = true;
    hdmi.status = "violation";
    hdmi.reason = `Duplicate/mirrored display detected (${agentStatus.physical_monitors} physical monitors)`;
    emit("hdmi", "done", hdmi);
  }

  appendAuditEvent("scan", {
    phase: "preflight",
    hdmi: hdmi.detected,
    mirror: mirror.detected,
    physicalMonitors: agentStatus?.physical_monitors ?? null,
    agentAlive,
  });

  return {
    hdmi,
    mirror,
    agent: { alive: agentAlive, status: agentStatus },
  };
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
  violationCache.clear();
  violationEscalation.clear();
  indeterminateStreak.clear();
  pendingReports.length = 0; // new-session boundary — drop any stale unsent reports

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
  if (preProceedInterval) return; // already running
  logger.info("[systemChecks] pre-proceed monitor started");
  preProceedInterval = setInterval(async () => {
    try {
      const { found } = await checkProcesses();
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
  clearInterval(preProceedInterval);
  preProceedInterval = null;
  logger.info("[systemChecks] pre-proceed monitor stopped");
}

module.exports = {
  start,
  stop,
  sendViolation,
  resetState,
  runChecksOnce,
  getAuditLog,
  startPreProceedMonitor,
  stopPreProceedMonitor,
};
