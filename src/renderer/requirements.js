/**
 * src/renderer/requirements.js
 * ─────────────────────────────
 * System Requirements screen controller.
 *
 * Checks run in two phases:
 *   1. Main process (via IPC): OS version, RAM, CPU, disk, internet
 *   2. Renderer (mediaDevices): Camera, Microphone
 *
 * All 7 checks must pass for the "Continue" button to be enabled.
 * Critical failures (OS, RAM, internet) show a stronger warning.
 */

"use strict";

// ─── Requirement Definitions ──────────────────────────────────────────────────

const REQUIREMENTS = [
  {
    id: "internet",
    label: "Internet Connection",
    description: "Stable connection required",
    critical: true,
    icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/>
    </svg>`,
  },
  {
    id: "camera",
    label: "Camera",
    description: "Webcam required for interview",
    critical: true,
    icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
    </svg>`,
  },
  {
    id: "mic",
    label: "Microphone",
    description: "Microphone required for interview",
    critical: true,
    icon: `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z"/>
    </svg>`,
  },
];

// ─── State ────────────────────────────────────────────────────────────────────

/** { [id]: { passed: boolean, detail: string } } */
const results = {};

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

function setCardState(id, state, detail = "") {
  const card   = document.getElementById(`req-card-${id}`);
  const icon   = document.getElementById(`req-icon-${id}`);
  const badge  = document.getElementById(`req-badge-${id}`);
  const detEl  = document.getElementById(`req-detail-${id}`);

  if (!card) { return; }

  detEl.textContent = detail;

  if (state === "scanning") {
    card.className  = "req-card req-card--scanning";
    badge.textContent = "Checking…";
    badge.className = "req-badge req-badge--scanning";
    icon.className  = "req-icon req-icon--scanning";
  } else if (state === "pass") {
    card.className  = "req-card req-card--pass";
    badge.textContent = "Ready";
    badge.className = "req-badge req-badge--pass";
    icon.className  = "req-icon req-icon--pass";
  } else if (state === "fail") {
    card.className  = "req-card req-card--fail";
    badge.textContent = "Required";
    badge.className = "req-badge req-badge--fail";
    icon.className  = "req-icon req-icon--fail";
  } else if (state === "warn") {
    card.className  = "req-card req-card--warn";
    badge.textContent = "Warning";
    badge.className = "req-badge req-badge--warn";
    icon.className  = "req-icon req-icon--warn";
  }
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function runMediaDeviceChecks() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    const mics    = devices.filter((d) => d.kind === "audioinput");

    const camOk = cameras.length > 0;
    const micOk = mics.length > 0;

    setCardState("camera", camOk ? "pass" : "fail",
      camOk ? `${cameras.length} camera device${cameras.length > 1 ? "s" : ""} detected` : "No camera found — please connect a webcam");

    setCardState("mic", micOk ? "pass" : "fail",
      micOk ? `${mics.length} microphone${mics.length > 1 ? "s" : ""} detected` : "No microphone found — please connect one");

    results.camera = { passed: camOk };
    results.mic    = { passed: micOk };

  } catch (err) {
    setCardState("camera", "warn", "Unable to check — browser permission may be required");
    setCardState("mic",    "warn", "Unable to check — browser permission may be required");
    results.camera = { passed: false };
    results.mic    = { passed: false };
  }
}

function applySystemResults(data) {
  // Internet only — OS/RAM/CPU/disk removed per product decision
  setCardState("internet", data.internet.passed ? "pass" : "fail",
    data.internet.passed ? "Connected" : "No internet connection detected — required for interview");
  results.internet = { passed: data.internet.passed };
}

// ─── Final Status ─────────────────────────────────────────────────────────────

function updateFinalStatus() {
  const btnContinue  = document.getElementById("btn-continue");
  const statusEl     = document.getElementById("req-status");
  const req          = REQUIREMENTS;

  const criticalFailed = req
    .filter((r) => r.critical)
    .filter((r) => results[r.id] && !results[r.id].passed);

  const allDone = req.every((r) => r.id in results);
  if (!allDone) { return; }

  if (criticalFailed.length === 0) {
    statusEl.textContent = "All requirements met. You're ready to proceed.";
    statusEl.className   = "text-emerald-600 font-semibold text-[14.5px]";
    btnContinue.disabled = false;
    btnContinue.className =
      "w-full max-w-xs bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 " +
      "text-white font-semibold py-3 rounded-xl shadow-lg shadow-indigo-600/30 hover:-translate-y-[1px] " +
      "active:translate-y-0 transition-all duration-200 flex items-center justify-center gap-2.5 cursor-pointer";
  } else {
    const names = criticalFailed.map((r) => r.label).join(", ");
    statusEl.textContent = `Requirements not met: ${names}. Please resolve before continuing.`;
    statusEl.className   = "text-rose-500 font-semibold text-[14.5px]";
    btnContinue.disabled = true;
    btnContinue.className =
      "w-full max-w-xs bg-slate-200 text-slate-400 font-semibold py-3 rounded-xl " +
      "transition-all duration-200 flex items-center justify-center gap-2.5 cursor-not-allowed";
  }
}

// ─── Main Flow ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const btnContinue = document.getElementById("btn-continue");
  const btnQuit     = document.getElementById("btn-quit");

  btnQuit?.addEventListener("click", () => window.electronAPI?.quitApp());

  btnContinue.addEventListener("click", () => {
    if (window.electronAPI) {
      btnContinue.disabled = true;
      btnContinue.innerHTML = `
        <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg> Loading…`;
      window.electronAPI.proceedToPreflight();
    }
  });

  // Set all cards to scanning state
  REQUIREMENTS.forEach((r) => setCardState(r.id, "scanning", "Checking…"));

  if (!window.electronAPI) {
    // Preview mode — mock pass all
    REQUIREMENTS.forEach((r) => {
      results[r.id] = { passed: true };
      setCardState(r.id, "pass", "Check passed (preview mode)");
    });
    updateFinalStatus();
    return;
  }

  try {
    // Run internet check (IPC) and media device checks in parallel
    const [sysData] = await Promise.all([
      window.electronAPI.getSystemRequirements(),
      runMediaDeviceChecks(),
    ]);
    applySystemResults(sysData);
  } catch (err) {
    console.error("[requirements] check error:", err);
    // On error, mark internet as unknown — don't hard-block
    if (!("internet" in results)) {
      results.internet = { passed: true };
      setCardState("internet", "warn", "Could not check — assuming connected");
    }
  }

  updateFinalStatus();
});
