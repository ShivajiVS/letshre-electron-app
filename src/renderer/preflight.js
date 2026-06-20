/**
 * src/renderer/preflight.js
 * ─────────────────────────
 * Preflight security check UI controller.
 *
 * Communicates with the main process via window.electronAPI (contextBridge).
 * App lists and display names are sourced from shared/appList.js.
 */

"use strict";

// NOTE: In Electron's renderer (sandboxed), Node require() is not available.
// The shared data below is inlined at build time OR can be loaded via a
// bundler. For now it mirrors shared/appList.js directly.
// If you add a bundler (e.g. esbuild), replace with: require('../shared/appList')

let MEETING_APPS = [];
let SCREEN_SHARING_APPS = [];
let AI_CHEATING_APPS = [];
let APP_DISPLAY_NAMES = {};

function getDisplayName(processName) {
  return APP_DISPLAY_NAMES[processName] || processName;
}

// ─── Icon Templates ───────────────────────────────────────────────────────────

const ICONS = {
  loading:
    '<svg class="w-5 h-5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
  success:
    '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
  error:
    '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>',
};

// ─── State ──────────────────────────────────────────────────────────────────────────────

let remainingBlockedApps = 0;

// ─── DOM References ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const btnRescan  = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");

  if (window.electronAPI) {
    try {
      const appList = await window.electronAPI.getAppList();
      MEETING_APPS = appList.meetingApps;
      SCREEN_SHARING_APPS = appList.screenSharingApps;
      AI_CHEATING_APPS = appList.aiCheatingApps || [];
      APP_DISPLAY_NAMES = appList.displayNames;
    } catch (e) {
      console.error("Failed to load app list", e);
    }
  }

  // ── App version footer ─────────────────────────────────────────────────────
  if (window.electronAPI?.getAppVersion) {
    window.electronAPI.getAppVersion().then((v) => {
      const el = document.getElementById("app-version");
      if (el && v) { el.textContent = `v${v}`; }
    }).catch(() => {});
  }

  // ── Auto-updater card (consent-first; interview-safe — main gates everything) ─
  if (window.electronAPI?.onUpdateAvailable) {
    window.electronAPI.onUpdateAvailable((data) =>
      setUpdateCard({
        kind: "available",
        version: data?.version,
        sizeBytes: data?.sizeBytes ?? null,
        releaseNotes: data?.releaseNotes ?? null,
      })
    );
    window.electronAPI.onUpdateProgress?.((data) =>
      setUpdateCard({
        kind: "downloading",
        percent: data?.percent ?? 0,
        transferred: data?.transferred ?? null,
        total: data?.total ?? null,
      })
    );
    window.electronAPI.onUpdateDownloaded((data) =>
      setUpdateCard({ kind: "downloaded", version: data?.version })
    );
    window.electronAPI.onUpdateError?.(({ error }) => {
      // Update-check failures (no release yet, offline, feed parse) are NOT
      // candidate-actionable and must never interrupt the preflight. Log only.
      console.warn("[updater] background update check failed (ignored):", error);
    });
  }

  // ── Scan Lifecycle ──────────────────────────────────────────────────────

  async function runScans() {
    setLoadingState(btnProceed, btnRescan, finalStatus);

    if (!window.electronAPI) {
      // Non-Electron preview fallback
      setTimeout(() => setMockPassedState(finalStatus, btnProceed), 1000);
      return;
    }

    // ADD-02: Subscribe to per-step progress before invoking the scan.
    // Each card updates as soon as its check finishes — not all at the end.
    window.electronAPI.onPreflightProgress(({ step, status, result }) => {
      if (status === "done") {
        applyStepResult(step, result);
      }
      // 'running' — cards already show shimmer from setLoadingState; no action needed
    });

    try {
      const results = await window.electronAPI.runPreflight();
      // Cards were already updated via streaming events above.
      // processResults() re-applies them (idempotent) and sets the final button state.
      processResults(results, btnProceed, btnRescan, finalStatus);
    } catch (err) {
      console.error("[preflight] scan error:", err);
      // IMP-15: Structured error boundary with auto-retry countdown
      showScanError(finalStatus, btnRescan, err?.message || "Unknown error");
    } finally {
      // Always clean up the listener to prevent leaks on rescan
      window.electronAPI.removePreflightProgressListener?.();
    }
  }

  // ── Button Listeners ──────────────────────────────────────────────────────

  btnRescan.addEventListener("click", runScans);

  btnProceed.addEventListener("click", () => {
    if (window.electronAPI) {
      btnProceed.disabled = true;
      btnProceed.innerHTML = `${ICONS.loading  } Loading...`;
      window.electronAPI.proceedToInterview();
    }
  });

  // Minimize button — lets the user minimize the window to close flagged apps manually
  document.getElementById("btn-minimize")?.addEventListener("click", () => {
    window.electronAPI?.minimizeWindow();
  });

  // ── Initial Scan ──────────────────────────────────────────────────────────
  runScans();
});

// ─── Loading State ────────────────────────────────────────────────────────────

function setLoadingState(btnProceed, btnRescan, finalStatus) {
  btnProceed.disabled = true;
  btnProceed.className =
    "w-64 bg-slate-100 text-slate-400 font-semibold py-3 rounded-xl border border-slate-200 transition-all flex items-center justify-center gap-3 cursor-not-allowed whitespace-nowrap";
  btnRescan.disabled = true;
  finalStatus.textContent = "Running security diagnostics...";
  finalStatus.className = "text-slate-500 font-medium";

  ["hdmi", "meeting", "screen", "wireless", "ai"].forEach((id) => {
    const iconEl = document.getElementById(`icon-${id}`);
    const badgeEl = document.getElementById(`badge-${id}`);
    const actionsEl = document.getElementById(`actions-${id}`);

    if (iconEl) {
      iconEl.innerHTML = ICONS.loading;
      iconEl.className =
        "w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 border border-slate-200/40 flex-shrink-0 transition-all duration-300";
    }
    if (badgeEl) {
      badgeEl.className =
        "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200/30";
      badgeEl.textContent = "Scanning";
    }
    if (actionsEl) {actionsEl.innerHTML = "";}
  });

  // Remove stale agent card
  document.getElementById("card-agent")?.remove();
}

// ─── Results Processing ───────────────────────────────────────────────────────

/**
 * ADD-02: Apply a single step's result to its cards immediately.
 * Called both from the streaming progress listener AND from processResults()
 * (idempotent — calling twice with the same data is harmless).
 *
 * @param {string} step  - 'hdmi' | 'mirror' | 'agent'
 * @param {object} result - the result object for that step
 * @returns {boolean}    - true if this step passed (used by processResults allPassed)
 */
function applyStepResult(step, result) {
  if (!result) { return true; }

  switch (step) {
    case "hdmi":
      if (result.detected) {
        updateCard("hdmi", false, "Disconnect all external displays/cables.");
        return false;
      }
      updateCard("hdmi", true, "No external display detected.");
      return true;

    case "mirror": {
      const procs        = result.details?.processes || [];
      remainingBlockedApps = procs.length;

      const foundMeeting = procs.filter((p) => MEETING_APPS.includes(p));
      const foundScreen  = procs.filter((p) => SCREEN_SHARING_APPS.includes(p));
      const foundAi      = procs.filter((p) => AI_CHEATING_APPS.includes(p));
      const foundOther   = procs.filter((p) => !MEETING_APPS.includes(p) && !SCREEN_SHARING_APPS.includes(p) && !AI_CHEATING_APPS.includes(p));

      if (foundMeeting.length > 0) {
        updateCard("meeting", false, "These meeting apps are still running:", foundMeeting);
      } else {
        updateCard("meeting", true, "No meeting apps detected.");
      }

      if (foundScreen.length > 0) {
        updateCard("screen", false, "These screen sharing apps are still running:", foundScreen);
      } else {
        updateCard("screen", true, "No screen sharing detected.");
      }

      if (foundAi.length > 0) {
        updateCard("ai", false, "These AI copilot tools are still running:", foundAi);
      } else {
        updateCard("ai", true, "No AI cheating tools detected.");
      }

      const wirelessFailed =
        foundOther.length > 0 ||
        (result.detected && foundMeeting.length === 0 && foundScreen.length === 0 && foundAi.length === 0);

      if (wirelessFailed) {
        if (foundOther.length > 0) {
          updateCard("wireless", false, "These remote/casting apps are still running:", foundOther);
        } else {
          updateCard("wireless", false, "Suspicious resolution detected — possible screen mirroring.");
        }
      } else {
        updateCard("wireless", true, "No casting/mirroring detected.");
      }

      return !(foundMeeting.length > 0 || foundScreen.length > 0 || foundAi.length > 0 || wirelessFailed);
    }

    case "agent":
      return renderAgentCard(result);

    default:
      return true;
  }
}

/**
 * Called once all checks are complete. Applies step results (idempotent with
 * streaming) and sets the final proceed button + status message.
 */
function processResults(results, btnProceed, btnRescan, finalStatus) {
  // Apply each step (cards may already be updated via streaming — idempotent)
  const hdmiPassed    = applyStepResult("hdmi",   results.hdmi);
  const mirrorPassed  = applyStepResult("mirror", results.mirror);
  const agentPassed   = applyStepResult("agent",  results.agent);

  // Since mirror handles meeting, screen, AI, and wireless, we just check mirrorPassed
  const allPassed = hdmiPassed && mirrorPassed && agentPassed;

  btnRescan.disabled = false;

  if (allPassed) {
    finalStatus.textContent = "All security checks passed. You are ready to start.";
    finalStatus.className =
      "text-emerald-600 font-semibold text-[15px] flex items-center gap-2";
    btnProceed.disabled = false;
    btnProceed.className =
      "w-64 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-semibold py-3 rounded-xl shadow-lg shadow-indigo-600/35 hover:shadow-xl hover:shadow-indigo-600/40 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 flex items-center justify-center gap-2.5 cursor-pointer whitespace-nowrap border border-indigo-500/20";
  } else {
    finalStatus.textContent = "Please resolve the security alerts above to proceed.";
    finalStatus.className = "text-rose-500 font-semibold text-[15px]";
    btnProceed.disabled = true;
    btnProceed.className =
      "w-64 bg-slate-200 text-slate-400 font-semibold py-3 rounded-xl transition-all duration-200 flex items-center justify-center gap-2.5 cursor-not-allowed whitespace-nowrap";
  }
}

// ─── Card Updates ─────────────────────────────────────────────────────────────

function updateCard(id, passed, msg, blockedApps = []) {
  const cardEl = document.getElementById(`card-${id}`);
  const iconEl = document.getElementById(`icon-${id}`);
  const descEl = document.getElementById(`desc-${id}`);
  const actionsEl = document.getElementById(`actions-${id}`);
  const badgeEl = document.getElementById(`badge-${id}`);

  if (actionsEl) {actionsEl.innerHTML = "";}

  if (passed) {
    cardEl.className =
      "glass-card rounded-2xl p-5 flex flex-col border border-slate-200/50 hover:shadow-md hover:border-slate-300/60 transition-all-custom gap-3";
    iconEl.innerHTML = ICONS.success;
    iconEl.className =
      "w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-200/40 shadow-sm flex-shrink-0 transition-all duration-300";
    descEl.textContent = msg;
    descEl.className = "text-slate-500 text-[13px] font-medium mt-1";
    if (badgeEl) {
      badgeEl.className =
        "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/30";
      badgeEl.textContent = "Ready";
    }
  } else {
    cardEl.className =
      "glass-card rounded-2xl p-5 flex flex-col border border-rose-200/50 shadow-sm hover:shadow-md hover:border-rose-300/60 transition-all-custom gap-3 glow-red";
    iconEl.innerHTML = ICONS.error;
    iconEl.className =
      "w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center border border-rose-200/40 shadow-sm flex-shrink-0 transition-all duration-300";
    descEl.textContent = msg;
    descEl.className = "text-rose-700 text-[13px] font-semibold mt-1";
    if (badgeEl) {
      badgeEl.className =
        "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/30 pulse-soft animate-pulse";
      badgeEl.textContent = "Action Required";
    }

    if (blockedApps.length > 0) {
      renderKillButtons(actionsEl, blockedApps);
    }
  }
}

// ─── Kill Buttons ─────────────────────────────────────────────────────────────

function renderKillButtons(container, blockedApps) {
  blockedApps.forEach((appName) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between bg-slate-50/50 rounded-xl px-4 py-2.5 border border-slate-200/30 mt-1.5 transition-all-custom hover:bg-slate-50";

    row.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
        </span>
        <div class="flex flex-col">
          <span class="text-slate-800 text-sm font-semibold leading-none">${getDisplayName(appName)}</span>
          <span class="text-slate-400 text-[10px] font-medium mt-1.5">${appName}</span>
        </div>
      </div>`;

    const btn = document.createElement("button");
    btn.className =
      "bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-700 font-semibold text-xs py-1.5 px-3.5 rounded-xl border border-rose-200/50 transition-all-custom active:scale-95 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
    btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Close ${getDisplayName(appName)}`;
    btn.addEventListener("click", () => handleKillApp(btn, appName, row));

    row.appendChild(btn);
    container.appendChild(row);
  });

  if (blockedApps.length > 1) {
    const closeAllBtn = document.createElement("button");
    closeAllBtn.className =
      "w-full bg-gradient-to-r from-slate-800 to-slate-900 hover:from-indigo-600 hover:to-indigo-700 text-white font-semibold text-xs py-2.5 px-4 rounded-xl transition-all-custom active:scale-[0.98] flex items-center justify-center gap-2 mt-2 shadow-sm";
    closeAllBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Close All & Re-scan`;
    closeAllBtn.addEventListener("click", () =>
      handleKillAll(closeAllBtn, blockedApps)
    );
    container.appendChild(closeAllBtn);
  }
}

// ─── Kill Handlers ────────────────────────────────────────────────────────────

async function handleKillApp(btn, processName, row) {
  btn.disabled = true;
  btn.className =
    "bg-amber-50 text-amber-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-amber-200/60 flex items-center gap-1.5 whitespace-nowrap cursor-wait shadow-sm";
  btn.innerHTML = `<svg class="w-3.5 h-3.5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing...`;

  try {
    const result = await window.electronAPI.killProcess(processName);

    if (result.success) {
      btn.className =
        "bg-emerald-50 text-emerald-700 font-semibold text-xs py-1.5 px-3.5 rounded-xl border border-emerald-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
      btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> Closed`;

      row.classList.add("opacity-50", "pointer-events-none");
      row.querySelector(".animate-ping")?.remove();
      const dot = row.querySelector(".bg-rose-500");
      if (dot) {dot.className = "relative inline-flex rounded-full h-2 w-2 bg-slate-400";}

      remainingBlockedApps = Math.max(0, remainingBlockedApps - 1);
      if (remainingBlockedApps === 0) {
        setTimeout(() => document.getElementById("btn-rescan")?.click(), 2000);
      }
    } else {
      btn.className =
        "bg-rose-50 text-rose-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-rose-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
      btn.innerHTML = `❌ Failed — close ${getDisplayName(processName)} manually`;
      btn.disabled = false;
    }
  } catch {
    btn.className =
      "bg-rose-50 text-rose-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-rose-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
    btn.innerHTML = `❌ Error — close ${getDisplayName(processName)} manually`;
    btn.disabled = false;
  }
}

async function handleKillAll(btn, processNames) {
  btn.disabled = true;
  btn.className =
    "w-full bg-gradient-to-r from-amber-500 to-amber-600 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md cursor-wait";
  btn.innerHTML = `<svg class="w-4 h-4 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing all apps...`;

  try {
    await window.electronAPI.killAllProcesses(processNames);
    btn.className =
      "w-full bg-gradient-to-r from-emerald-600 to-emerald-700 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md";
    btn.innerHTML = "✅ All apps closed — re-scanning...";
  } catch {
    btn.className =
      "w-full bg-gradient-to-r from-rose-500 to-rose-600 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md";
    btn.innerHTML = "❌ Some apps failed to close";
  }

  setTimeout(() => document.getElementById("btn-rescan")?.click(), 2000);
}

// ─── Agent Card ───────────────────────────────────────────────────────────────

function renderAgentCard(agent) {
  document.getElementById("card-agent")?.remove();
  const container = document.querySelector(".flex.flex-col.gap-4");
  if (!container) {return true;}

  const card = document.createElement("div");
  card.id = "card-agent";

  if (!agent || !agent.alive) {
    // Agent is REQUIRED — without it the deep behavioral scan (AI tools,
    // overlays, network, duplicate displays) cannot run. Render as a blocking
    // error, not an amber warning, so it's clear Proceed stays disabled.
    card.className =
      "glass-card rounded-2xl p-5 flex flex-col border border-rose-200/50 shadow-sm hover:shadow-md transition-all-custom gap-3 glow-red";
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center border border-rose-200/40 flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div>
            <h3 class="font-bold text-slate-900 text-[15.5px] leading-tight">Deep Scan Agent</h3>
            <p class="text-rose-700 text-[13px] font-semibold mt-1">Security agent failed to start — it is required to continue. Click Re-scan to retry.</p>
          </div>
        </div>
        <div class="text-[12px] font-semibold px-3 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/30 pulse-soft animate-pulse">Required</div>
      </div>`;
    container.appendChild(card);
    return false;
  }

  const threats = agent.status?.threats || [];

  if (threats.length === 0) {
    card.className =
      "glass-card rounded-2xl p-5 flex flex-col border border-slate-200/50 hover:shadow-md transition-all-custom gap-3";
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-200/40 flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
          <div>
            <h3 class="font-bold text-slate-900 text-[15.5px] leading-tight">Deep Scan Agent</h3>
            <p class="text-slate-500 text-[13px] font-medium mt-1">No AI tools, network anomalies, or automation frameworks detected.</p>
          </div>
        </div>
        <div class="text-[12px] font-semibold px-3 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/30">Ready</div>
      </div>`;
    container.appendChild(card);
    return true;
  }

  card.className =
    "glass-card rounded-2xl p-5 flex flex-col border border-rose-200/50 shadow-sm hover:shadow-md transition-all-custom gap-3";

  const threatRows = threats
    .map(
      (t) => `
    <div class="flex items-start gap-3 bg-slate-50/50 rounded-xl px-4 py-2.5 border border-slate-200/30 mt-1.5">
      <span class="relative flex h-2 w-2 mt-1.5 flex-shrink-0">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
      </span>
      <div>
        <span class="text-slate-800 text-sm font-semibold">
          ${t.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </span>
        <p class="text-slate-500 text-[12px] mt-0.5">${t.detail}</p>
      </div>
      <span class="ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full ${
        t.severity === "HIGH"
          ? "bg-rose-50 text-rose-700 border border-rose-200/40"
          : "bg-amber-50 text-amber-700 border border-amber-200/40"
      }">${t.severity}</span>
    </div>`
    )
    .join("");

  card.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center border border-rose-200/40 flex-shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </div>
        <div>
          <h3 class="font-bold text-slate-900 text-[15.5px] leading-tight">Deep Scan Agent</h3>
          <p class="text-rose-700 text-[13px] font-semibold mt-1">
            ${threats.length} behavioral threat${threats.length > 1 ? "s" : ""} detected. Close the applications below and rescan.
          </p>
        </div>
      </div>
      <div class="text-[12px] font-semibold px-3 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/30 pulse-soft animate-pulse">
        Action Required
      </div>
    </div>
    <div class="flex flex-col gap-1 mt-1">${threatRows}</div>`;

  container.appendChild(card);
  return false;
}

// ─── Mock Fallback (non-Electron preview) ─────────────────────────────────────

function setMockPassedState(finalStatus, btnProceed) {
  ["hdmi", "meeting", "screen", "wireless"].forEach((id) =>
    updateCard(id, true, "Check passed (preview mode).")
  );
  finalStatus.textContent = "Preview mode — all checks simulated as passed.";
  btnProceed.disabled = false;
}

// ─── Error Boundary (IMP-15) ─────────────────────────────────────────────────

/**
 * Displays a structured scan-failure message with an auto-retry countdown.
 * Replaces the silent "Error running diagnostics." grey text.
 * @param {HTMLElement} finalStatus
 * @param {HTMLButtonElement} btnRescan
 * @param {string} message
 */
function showScanError(finalStatus, btnRescan, message) {
  btnRescan.disabled = false;
  let seconds = 5;

  finalStatus.className = "text-amber-600 font-semibold text-[14.5px]";
  finalStatus.textContent = `Diagnostics failed: ${message} — retrying in ${seconds}s…`;

  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      btnRescan.click();
    } else {
      finalStatus.textContent = `Diagnostics failed: ${message} — retrying in ${seconds}s…`;
    }
  }, 1000);
}

// ─── Auto-Updater Card ────────────────────────────────────────────────────────
// Consent-first, bottom-right floating card. The main process gates download and
// install (never during an interview); the renderer only reflects state and
// relays the user's choice. Update-check failures never render anything.

let _update = { kind: "idle", notesOpen: false };

/** Formats a byte count as a compact human string (e.g. "12.4 MB"). */
function formatBytes(bytes) {
  if (!bytes || bytes < 0) { return ""; }
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Escapes text for safe insertion into the DOM (release notes are remote). */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

window.__updateAction = (action) => {
  if (action === "download") {
    window.electronAPI?.downloadUpdate?.();
    setUpdateCard({ kind: "downloading", percent: 0 });
  } else if (action === "install") {
    window.electronAPI?.installUpdate?.();
  } else if (action === "notes") {
    setUpdateCard({ notesOpen: !_update.notesOpen });
  } else if (action === "dismiss") {
    setUpdateCard({ kind: "idle" });
  }
};

function setUpdateCard(next) {
  _update = { ..._update, ...next };
  renderUpdateCard();
}

function renderUpdateCard() {
  const s = _update;
  const existing = document.getElementById("update-card");

  if (!s || s.kind === "idle") { existing?.remove(); return; }

  let card = existing;
  if (!card) {
    card = document.createElement("div");
    card.id = "update-card";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    document.body.appendChild(card);
  }

  card.className = "update-card";
  card.innerHTML = updateCardBody(s);
}

function updateCardBody(s) {
  const icon = {
    available: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
    downloading: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/>',
    downloaded: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>',
  }[s.kind] || "";

  const head = (title, tone = "") => `
    <div class="update-card__head">
      <span class="update-card__icon ${tone}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icon}</svg>
      </span>
      <span class="update-card__title">${title}</span>
      ${s.version ? `<span class="update-card__chip">v${escapeHtml(s.version)}</span>` : ""}
    </div>`;

  const notes = s.releaseNotes
    ? `<button class="update-card__notes-toggle" onclick="window.__updateAction('notes')">
         ${s.notesOpen ? "Hide" : "What’s new"}
       </button>
       ${s.notesOpen ? `<div class="update-card__notes">${escapeHtml(
         typeof s.releaseNotes === "string" ? s.releaseNotes : ""
       ).slice(0, 1200)}</div>` : ""}`
    : "";

  switch (s.kind) {
    case "available": {
      const size = s.sizeBytes ? ` (${formatBytes(s.sizeBytes)})` : "";
      return `
        ${head("Update available")}
        <p class="update-card__body">A new version is ready to download${size}.</p>
        ${notes}
        <div class="update-card__actions">
          <button class="update-card__btn update-card__btn--primary" onclick="window.__updateAction('download')">Download</button>
          <button class="update-card__btn update-card__btn--ghost" onclick="window.__updateAction('dismiss')">Not now</button>
        </div>`;
    }
    case "downloading": {
      const pct = Math.max(0, Math.min(100, s.percent ?? 0));
      const sizeLine = (s.transferred && s.total)
        ? `${formatBytes(s.transferred)} / ${formatBytes(s.total)}`
        : "";
      return `
        ${head("Downloading update")}
        <div class="update-card__progress"><div class="update-card__progress-bar" style="width:${pct}%"></div></div>
        <p class="update-card__meta"><span>${pct}%</span><span>${sizeLine}</span></p>`;
    }
    case "downloaded":
      return `
        ${head("Update ready", "update-card__icon--ok")}
        <p class="update-card__body">It will install silently and reopen.</p>
        <div class="update-card__actions">
          <button class="update-card__btn update-card__btn--primary" onclick="window.__updateAction('install')">Restart &amp; update</button>
          <button class="update-card__btn update-card__btn--ghost" onclick="window.__updateAction('dismiss')">Later</button>
        </div>
        <p class="update-card__hint">“Later” installs the update next time you close the app.</p>`;
    default:
      return "";
  }
}

