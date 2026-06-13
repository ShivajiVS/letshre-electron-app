const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const { pingAgent, fetchAgentStatus, triggerAgentScan } = require("./agentClient");
const axios = require("axios");
const path = require("path");

const SERVER_URL = "https://api.letshyre.com";

let violationCache = new Map();
const COOLDOWN = 15000; // ms between repeated reports of the same event
let isViolationActive = false;

// Anti-tamper: track whether the agent was alive at interview start
let agentWasAlive = false;
let agentTamperInterval = null;

// ─────────────────────────────────────────────────────────────
//  INTERVIEW MONITOR (runs every 5 s during active interview)
// ─────────────────────────────────────────────────────────────
function start(win, accessToken) {
  // --- 1. Standard hardware checks (HDMI + mirroring) ---
  setInterval(async () => {
    if (isViolationActive) return;
    try {
      const hdmi   = await detectHDMIWindows();
      const mirror = await detectMirroring();

      if (hdmi.detected) {
        sendViolation(win, hdmi.reason || "External display detected", "high", accessToken);
      }
      if (mirror.detected) {
        sendViolation(win, mirror.reason || "Mirroring suspected", "medium", accessToken);
      }

      // Report hardware state to backend
      await axios
        .post(`${SERVER_URL}/report`, {
          timestamp: new Date(),
          accessToken,
          hdmi,
          mirror,
        })
        .catch(() => {}); // never let a report failure crash the loop

    } catch (e) {
      console.log("Detection error:", e.message);
    }
  }, 5000);

  // --- 2. Agent deep-scan poll (runs every 5 s) ---
  setInterval(async () => {
    if (isViolationActive) return;
    try {
      const status = await fetchAgentStatus();
      if (!status) return; // agent offline — handled by anti-tamper below

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
      console.log("Agent poll error:", e.message);
    }
  }, 5000);

  // --- 3. Anti-tamper: ping agent every 10 s ---
  //  If the agent goes silent mid-interview, treat it as a HIGH violation.
  //  (Cheater could kill agent.exe via Task Manager after preflight passes)
  agentWasAlive = true; // main.js already confirmed it was alive before start()
  agentTamperInterval = setInterval(async () => {
    if (isViolationActive) return;
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
      console.log("Anti-tamper ping error:", e.message);
    }
  }, 10000);
}

// ─────────────────────────────────────────────────────────────
//  VIOLATION HANDLER
// ─────────────────────────────────────────────────────────────
async function sendViolation(win, event, severity, accessToken = null) {
  const now = Date.now();

  // Cooldown — avoid spamming the same event
  if (violationCache.has(event)) {
    if (now - violationCache.get(event) < COOLDOWN) return;
  }
  violationCache.set(event, now);

  console.log("VIOLATION:", event);

  // Show violation screen in Electron window
  if (win && !isViolationActive) {
    isViolationActive = true;
    win.loadFile(path.join(__dirname, "../../assets/violation.html"), {
      query: { reason: event },
    });
  }

  // Report to backend
  try {
    await axios.post(`${SERVER_URL}/violation`, {
      event,
      severity,
      source: "electron",
      accessToken,
      timestamp: new Date(),
    });
  } catch {
    console.log("Violation API failed");
  }
}

// ─────────────────────────────────────────────────────────────
//  PREFLIGHT: run all checks once and return combined result
// ─────────────────────────────────────────────────────────────
async function runChecksOnce() {
  const hdmi   = await detectHDMIWindows();
  const mirror = await detectMirroring();

  // Also get agent deep-scan result for the preflight UI
  const agentAlive  = await pingAgent();
  const agentStatus = agentAlive ? await triggerAgentScan() : null;

  return {
    hdmi,
    mirror,
    agent: {
      alive: agentAlive,
      status: agentStatus, // null if agent is not running
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  RESET (called when user hits "Recheck System")
// ─────────────────────────────────────────────────────────────
function resetState() {
  isViolationActive = false;
  agentWasAlive     = false;
  violationCache.clear();

  if (agentTamperInterval) {
    clearInterval(agentTamperInterval);
    agentTamperInterval = null;
  }
}

module.exports = {
  start,
  sendViolation,
  resetState,
  runChecksOnce,
};
