const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { pingAgent, fetchAgentStatus, triggerAgentScan } = require("./agentClient");
const axios = require("axios");
const path = require("path");
const logger = require("../main/logger");
const {
  API_BASE_URL,
  VIOLATION_COOLDOWN_MS,
  DETECTION_INTERVAL_MS,
  TAMPER_CHECK_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} = require("../shared/constants");

// ─── State ────────────────────────────────────────────────────────────────────

const violationCache      = new Map(); // event key → last-fired timestamp
const violationEscalation = new Map(); // event key → total fire count (ADD-06)
let isViolationActive = false;

// Anti-tamper: track whether the agent was alive at interview start
let agentWasAlive = false;

// Detection loop interval refs — ALL stored so resetState() clears every one (IMP-06)
let hdmiInterval        = null;
let agentPollInterval   = null;
let agentTamperInterval = null;
let heartbeatInterval   = null; // ADD-05

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
function start(win, accessToken) {
  // --- 1. Standard hardware checks (HDMI + mirroring) ---
  hdmiInterval = setInterval(async () => {
    if (isViolationActive) { return; }
    try {
      const hdmi   = await detectHDMIWindows();
      const mirror = await detectMirroring();

      appendAuditEvent("scan", { hdmi: hdmi.detected, mirror: mirror.detected });

      if (hdmi.detected) {
        sendViolation(win, hdmi.reason || "External display detected", "high", accessToken);
      }
      if (mirror.detected) {
        sendViolation(win, mirror.reason || "Mirroring suspected", "medium", accessToken);
      }

      // Report hardware state to backend
      await axios
        .post(`${API_BASE_URL}/report`, {
          timestamp: new Date(),
          accessToken,
          hdmi,
          mirror,
        })
        .catch(() => {}); // never let a report failure crash the loop

    } catch (e) {
      logger.warn("[systemChecks] detection error:", e.message);
    }
  }, DETECTION_INTERVAL_MS);

  // --- 2. Agent deep-scan poll (runs every 5 s) ---
  agentPollInterval = setInterval(async () => {
    if (isViolationActive) { return; }
    try {
      const status = await fetchAgentStatus();
      if (!status) { return; } // agent offline — handled by anti-tamper below

      appendAuditEvent("agent", { safeToproceed: status.safe_to_proceed, threatCount: status.threats?.length ?? 0 });

      if (!status.safe_to_proceed && status.threats && status.threats.length > 0) {
        // Send the first unhandled threat as a violation
        const threat = status.threats[0];
        sendViolation(
          win,
          threat.detail || "Behavioral threat detected",
          threat.severity === "HIGH" ? "high" : "medium",
          accessToken
        );
      }
    } catch (e) {
      logger.warn("[systemChecks] agent poll error:", e.message);
    }
  }, DETECTION_INTERVAL_MS);

  // --- 3. Anti-tamper: ping agent every 10 s ---
  //  If the agent goes silent mid-interview, treat it as a HIGH violation.
  //  (Cheater could kill agent.exe via Task Manager after preflight passes)
  agentWasAlive = true; // main.js already confirmed it was alive before start()
  agentTamperInterval = setInterval(async () => {
    if (isViolationActive) { return; }
    try {
      const alive = await pingAgent();
      if (!alive && agentWasAlive) {
        agentWasAlive = false;
        sendViolation(
          win,
          "Security agent was terminated — possible tamper attempt",
          "high",
          accessToken
        );
      } else if (alive) {
        agentWasAlive = true;
      }
    } catch (e) {
      logger.warn("[systemChecks] anti-tamper ping error:", e.message);
    }
  }, TAMPER_CHECK_INTERVAL_MS);

  // --- 4. Session heartbeat (ADD-05) ---
  //  Sends a 30 s heartbeat to the backend.
  //  If the backend stops receiving it, the session can be flagged as suspicious.
  heartbeatInterval = setInterval(async () => {
    try {
      const alive = await pingAgent();
      appendAuditEvent("heartbeat", { agentAlive: alive });
      await axios
        .post(`${API_BASE_URL}/heartbeat`, {
          accessToken,
          timestamp: new Date().toISOString(),
          agentAlive: alive,
        })
        .catch(() => {}); // never let a heartbeat failure disrupt detection
    } catch (e) {
      logger.warn("[systemChecks] heartbeat error:", e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────
//  VIOLATION HANDLER
// ─────────────────────────────────────────────────────────────

/**
 * Records, escalates, and reports a security violation.
 *
 * ADD-06 — Escalation logic:
 *   - HIGH severity → always show violation screen immediately.
 *   - MEDIUM severity, 1st occurrence → log to backend only (soft block).
 *     Candidate gets one chance to self-correct before the session is blocked.
 *   - MEDIUM severity, 2nd+ occurrence → show violation screen (hard block).
 *
 * @param {Electron.BrowserWindow | null} win
 * @param {string} event
 * @param {"high"|"medium"} severity
 * @param {string|null} accessToken
 */
async function sendViolation(win, event, severity, accessToken = null) {
  const now = Date.now();

  // ── Cooldown gate ─────────────────────────────────────────
  if (violationCache.has(event)) {
    if (now - violationCache.get(event) < VIOLATION_COOLDOWN_MS) { return; }
  }
  violationCache.set(event, now);

  // ── Escalation tracking (ADD-06) ─────────────────────────
  const prevCount = violationEscalation.get(event) || 0;
  const count     = prevCount + 1;
  violationEscalation.set(event, count);

  const isHardBlock = severity === "high" || count >= 2;

  appendAuditEvent("violation", { event, severity, count, isHardBlock });
  logger.warn("[systemChecks] VIOLATION:", event, `| severity: ${severity} | count: ${count} | hardBlock: ${isHardBlock}`);

  // ── Show violation screen (hard blocks only) ─────────────
  if (win && !isViolationActive && isHardBlock) {
    isViolationActive = true;
    win.loadFile(path.join(__dirname, "../../assets/violation.html"), {
      query: { reason: event },
    });
  }

  // ── Report to backend (always, including soft blocks) ─────
  try {
    await axios.post(`${API_BASE_URL}/violation`, {
      event,
      severity,
      escalationCount: count,
      isHardBlock,
      source: "electron",
      accessToken,
      timestamp: new Date().toISOString(),
    });
  } catch {
    logger.error("[systemChecks] violation API failed");
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
