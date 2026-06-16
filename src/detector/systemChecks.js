const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { pingAgent, fetchAgentStatus, triggerAgentScan } = require("./agentClient");
const logger = require("../main/logger");
const {
  IPC,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  TAMPER_CHECK_INTERVAL_MS,
} = require("../shared/constants");

// ─── State ────────────────────────────────────────────────────────────────────

const violationCache      = new Map(); // event key → last-fired timestamp
const violationEscalation = new Map(); // event key → total fire count (ADD-06)
// NOTE: isViolationActive removed — website now owns violation state via PUSH_VIOLATION bridge

// Anti-tamper: track whether the agent was alive at interview start
let agentWasAlive = false;

// Detection loop interval refs — ALL stored so resetState() clears every one (IMP-06)
let hdmiInterval        = null;
let agentPollInterval   = null;
let agentTamperInterval = null;

// ─── Audit Trail (ADD-07) ─────────────────────────────────────────────────────

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
  if (auditLog.length > 500) { auditLog.shift(); }
}

/** Returns a copy of the audit log. Exposed via IPC GET_AUDIT_LOG. */
function getAuditLog() {
  return [...auditLog];
}

// ─────────────────────────────────────────────────────────────
//  INTERVIEW MONITOR (runs every 5 s during active interview)
// ─────────────────────────────────────────────────────────────
function start(win) {
  // --- 1. Standard hardware checks (HDMI + mirroring) ---
  hdmiInterval = setInterval(async () => {
    try {
      const hdmi   = await detectHDMIWindows();
      const mirror = await detectMirroring();

      appendAuditEvent("scan", { hdmi: hdmi.detected, mirror: mirror.detected });

      if (hdmi.detected) {
        sendViolation(win, hdmi.reason || "External display detected", "high");
      }
      if (mirror.detected) {
        sendViolation(win, mirror.reason || "Mirroring suspected", "medium");
      }

    } catch (e) {
      logger.warn("[systemChecks] detection error:", e.message);
    }
  }, DETECTION_INTERVAL_MS);

  // --- 2. Agent deep-scan poll (runs every 5 s) ---
  agentPollInterval = setInterval(async () => {
    try {
      const status = await fetchAgentStatus();
      if (!status) { return; } // agent offline — handled by anti-tamper below

      appendAuditEvent("agent", { safeToproceed: status.safe_to_proceed, threatCount: status.threats?.length ?? 0 });

      if (!status.safe_to_proceed && status.threats && status.threats.length > 0) {
        const threat = status.threats[0];
        sendViolation(
          win,
          threat.detail || "Behavioral threat detected",
          threat.severity === "HIGH" ? "high" : "medium"
        );
      }
    } catch (e) {
      logger.warn("[systemChecks] agent poll error:", e.message);
    }
  }, DETECTION_INTERVAL_MS);

  // --- 3. Anti-tamper: ping agent every 10 s ---
  agentWasAlive = true;
  agentTamperInterval = setInterval(async () => {
    try {
      const alive = await pingAgent();
      if (!alive && agentWasAlive) {
        agentWasAlive = false;
        sendViolation(win, "Security agent was terminated — possible tamper attempt", "high");
      } else if (alive) {
        agentWasAlive = true;
      }
    } catch (e) {
      logger.warn("[systemChecks] anti-tamper ping error:", e.message);
    }
  }, TAMPER_CHECK_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────
//  VIOLATION HANDLER
// ─────────────────────────────────────────────────────────────

/**
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
  const now = Date.now();

  // ── Cooldown gate ─────────────────────────────────────────────────────────
  if (violationCache.has(event)) {
    if (now - violationCache.get(event) < VIOLATION_COOLDOWN_MS) { return; }
  }
  violationCache.set(event, now);

  // ── Escalation tracking (ADD-06) ───────────────────────────────────────────────
  const prevCount = violationEscalation.get(event) || 0;
  const count     = prevCount + 1;
  violationEscalation.set(event, count);

  const isHardBlock = severity === "high" || count >= 2;

  appendAuditEvent("violation", { event, severity, count, isHardBlock });
  logger.warn("[systemChecks] VIOLATION:", event, `| severity: ${severity} | count: ${count} | hardBlock: ${isHardBlock}`);

  // ── Push to website via IPC bridge ───────────────────────────────────────────
  if (win) {
    _pushViolationToRenderer(win, { event, severity, count, isHardBlock });
  }
}

// ─────────────────────────────────────────────────────────────
//  PREFLIGHT: run all checks once and stream per-step progress
// ─────────────────────────────────────────────────────────────

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

  // ── Step 1: HDMI / external display check ────────────────────────────────
  emit("hdmi", "running");
  const hdmi = await detectHDMIWindows();
  emit("hdmi", "done", hdmi);

  // ── Step 2: Mirror / blocked-process scan ───────────────────────────────
  emit("mirror", "running");
  const mirror = await detectMirroring();
  emit("mirror", "done", mirror);

  // ── Step 3: Security agent deep scan ────────────────────────────────────
  emit("agent", "running");
  const agentAlive  = await pingAgent();
  const agentStatus = agentAlive ? await triggerAgentScan() : null;
  emit("agent", "done", { alive: agentAlive, status: agentStatus });

  appendAuditEvent("scan", {
    phase: "preflight",
    hdmi: hdmi.detected,
    mirror: mirror.detected,
    agentAlive,
  });

  return {
    hdmi,
    mirror,
    agent: { alive: agentAlive, status: agentStatus },
  };
}

// ─────────────────────────────────────────────────────────────
//  RESET (called when user hits "Recheck System")
// ─────────────────────────────────────────────────────────────
function resetState() {
  isViolationActive = false;
  agentWasAlive     = false;
  violationCache.clear();
  violationEscalation.clear();

  // IMP-06: Clear ALL interval refs (previously only agentTamperInterval was cleared)
  clearInterval(hdmiInterval);
  clearInterval(agentPollInterval);
  clearInterval(agentTamperInterval);
  clearInterval(heartbeatInterval);
  hdmiInterval        = null;
  agentPollInterval   = null;
  agentTamperInterval = null;
  heartbeatInterval   = null;
}

module.exports = {
  start,
  sendViolation,
  resetState,
  runChecksOnce,
  getAuditLog,
};
