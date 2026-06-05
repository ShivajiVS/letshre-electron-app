const { detectHDMIWindows } = require("./hdmiDetector");
const detectMirroring = require("./mirrorDetector");
const axios = require("axios");
const path = require("path");

const SERVER_URL = "http://localhost:8000";

let violationCache = new Map();
const COOLDOWN = 15000;
let isViolationActive = false;

function start(win) {
  setInterval(async () => {
    if (isViolationActive) return;
    try {
      const hdmi = await detectHDMIWindows();
      const mirror = await detectMirroring();

      // 🔥 Handle HDMI
      if (hdmi.detected) {
        sendViolation(win, hdmi.reason || "External display detected", "high");
      }

      // 🔥 Handle Mirroring
      if (mirror.detected) {
        sendViolation(win, mirror.reason || "Mirroring suspected", "medium");
      }

      // 🔥 Send full payload (optional logging)
      const payload = {
        timestamp: new Date(),
        hdmi: hdmi,
        mirror: mirror,
      };

      console.log("Detection:", payload);

      await axios.post(`${SERVER_URL}/report`, payload);
    } catch (e) {
      console.log("Detection error:", e.message);
    }
  }, 5000);
}

async function sendViolation(win, event, severity) {
  const now = Date.now();

  // 🔥 cooldown (avoid spam)
  if (violationCache.has(event)) {
    const last = violationCache.get(event);
    if (now - last < COOLDOWN) return;
  }

  violationCache.set(event, now);

  console.log("🚨", event);

  // 🔥 Show in UI (Block access)
  if (win && !isViolationActive) {
    isViolationActive = true;
    win.loadFile(path.join(__dirname, "../../assets/violation.html"), {
      query: { reason: event },
    });
  }

  // 🔥 Send to backend (violation endpoint)
  try {
    await axios.post(`${SERVER_URL}/violation`, {
      event,
      severity,
      source: "electron",
      timestamp: new Date(),
    });
  } catch {
    console.log("Violation API failed");
  }
}

function resetState() {
  isViolationActive = false;
  violationCache.clear();
}

async function runChecksOnce() {
  const hdmi = await detectHDMIWindows();
  const mirror = await detectMirroring();
  return { hdmi, mirror };
}

module.exports = {
  start,
  sendViolation,
  resetState,
  runChecksOnce,
};
