document.addEventListener("DOMContentLoaded", () => {
  const btnRescan = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");
  let remainingBlockedApps = 0;

  const icons = {
    loading: '<svg class="w-5 h-5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
    success: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
    error: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>'
  };

  // Friendly display names for process executables
  const APP_DISPLAY_NAMES = {
    // Meeting Apps
    "zoom.exe": "Zoom", "zoom.app": "Zoom", "zoom.us.app": "Zoom",
    "teams.exe": "Microsoft Teams", "teams.app": "Microsoft Teams", "microsoft teams.app": "Microsoft Teams",
    "ms-teams.exe": "Microsoft Teams", "msteams.exe": "Microsoft Teams",
    "webex.exe": "Webex", "webex.app": "Webex", "webex meetings.app": "Webex",
    "skype.exe": "Skype", "skype.app": "Skype",
    "gotomeeting.exe": "GoToMeeting", "gotomeeting.app": "GoToMeeting",

    // Screen Sharing / Recording
    "obs64.exe": "OBS Studio", "obs32.exe": "OBS Studio", "obs-studio.exe": "OBS Studio", "obs.app": "OBS Studio", "obs studio.app": "OBS Studio",
    "discord.exe": "Discord", "discord.app": "Discord",
    "slack.exe": "Slack", "slack.app": "Slack",
    "anydesk.exe": "AnyDesk", "anydesk.app": "AnyDesk",
    "teamviewer.exe": "TeamViewer", "teamviewer.app": "TeamViewer",
    "bandicam.exe": "Bandicam",
    "camtasia.exe": "Camtasia", "camtasia.app": "Camtasia",
    "snagit.exe": "Snagit", "snagit.app": "Snagit",

    // Casting / Mirroring
    "scrcpy.exe": "Scrcpy (Screen Mirror)", "scrcpy": "Scrcpy (Screen Mirror)",
    "miracast.exe": "Miracast",
    "apowermirror.exe": "ApowerMirror", "apowermirror.app": "ApowerMirror",
    "letsview.exe": "LetsView", "letsview.app": "LetsView",

    // Browsers
    "chrome.exe": "Google Chrome", "google chrome.app": "Google Chrome",
    "msedge.exe": "Microsoft Edge", "microsoft edge.app": "Microsoft Edge",
    "firefox.exe": "Firefox", "firefox.app": "Firefox",
    "safari.app": "Safari",
    "opera.exe": "Opera", "opera.app": "Opera",
    "brave.exe": "Brave", "brave.app": "Brave",
    "vivaldi.exe": "Vivaldi", "vivaldi.app": "Vivaldi",
  };

  function getDisplayName(processName) {
    return APP_DISPLAY_NAMES[processName] || processName;
  }

  const meetingApps = [
    "zoom.exe", "teams.exe", "ms-teams.exe", "msteams.exe", "webex.exe", "gotomeeting.exe", "skype.exe",
    "zoom.app", "zoom.us.app", "teams.app", "microsoft teams.app", "webex.app", "webex meetings.app", "gotomeeting.app", "skype.app"
  ];
  const screenSharingApps = [
    "obs64.exe", "obs32.exe", "obs-studio.exe", "discord.exe", "slack.exe", "bandicam.exe", "camtasia.exe", "snagit.exe",
    "obs.app", "obs studio.app", "discord.app", "slack.app", "camtasia.app", "snagit.app"
  ];
  
  async function runScans() {
    setLoadingState();
    
    if (!window.electronAPI) {
      setTimeout(() => setMockResults(), 1000);
      return;
    }

    try {
      const results = await window.electronAPI.runPreflight();
      processResults(results);
    } catch (e) {
      console.error(e);
      finalStatus.textContent = "Error running diagnostics.";
      finalStatus.classList.add("text-red-500");
    }
  }

  function setLoadingState() {
    btnProceed.disabled = true;
    btnProceed.className = "w-64 bg-slate-100 text-slate-400 font-semibold py-3 rounded-xl border border-slate-200 transition-all flex items-center justify-center gap-3 cursor-not-allowed whitespace-nowrap";
    btnRescan.disabled = true;
    finalStatus.textContent = "Running security diagnostics...";
    finalStatus.className = "text-slate-500 font-medium";

    ["hdmi", "meeting", "screen", "wireless"].forEach(id => {
      document.getElementById(`icon-${id}`).innerHTML = icons.loading;
      document.getElementById(`icon-${id}`).className = "w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 border border-slate-200/40 flex-shrink-0 transition-all duration-300";
      
      const badgeEl = document.getElementById(`badge-${id}`);
      if (badgeEl) {
        badgeEl.className = "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200/30";
        badgeEl.textContent = "Scanning";
      }

      // Clear previous action buttons
      const actionsEl = document.getElementById(`actions-${id}`);
      if (actionsEl) actionsEl.innerHTML = "";
    });

    // Remove previous agent card if it exists
    const existingAgentCard = document.getElementById("card-agent");
    if (existingAgentCard) existingAgentCard.remove();
  }

  function processResults(results) {
    let allPassed = true;

    // 1. HDMI
    if (results.hdmi.detected) {
      allPassed = false;
      updateCard("hdmi", false, "Disconnect all external displays/cables.");
    } else {
      updateCard("hdmi", true, "No external display detected.");
    }

    // Process array
    const procs = results.mirror.details.processes || [];
    remainingBlockedApps = procs.length;
    
    // 2. Meeting Apps
    const foundMeeting = procs.filter(p => meetingApps.includes(p));
    if (foundMeeting.length > 0) {
      allPassed = false;
      updateCard("meeting", false, "These meeting apps are still running in the background:", foundMeeting);
    } else {
      updateCard("meeting", true, "No meeting apps detected.");
    }

    // 3. Screen Sharing
    const foundScreen = procs.filter(p => screenSharingApps.includes(p));
    if (foundScreen.length > 0) {
      allPassed = false;
      updateCard("screen", false, "These screen sharing apps are still running in the background:", foundScreen);
    } else {
      updateCard("screen", true, "No screen sharing detected.");
    }

    // 4. Wireless/Remote
    const foundOther = procs.filter(p => !meetingApps.includes(p) && !screenSharingApps.includes(p));
    if (foundOther.length > 0 || (results.mirror.detected && foundMeeting.length === 0 && foundScreen.length === 0)) {
      allPassed = false;
      if (foundOther.length > 0) {
        updateCard("wireless", false, "These remote/casting apps are still running in the background:", foundOther);
      } else {
        updateCard("wireless", false, "Suspicious resolution detected — possible screen mirroring.");
      }
    } else {
      updateCard("wireless", true, "No casting/mirroring detected.");
    }

    // 5. Agent deep-scan results
    const agentPassed = renderAgentCard(results.agent);
    if (!agentPassed) allPassed = false;

    btnRescan.disabled = false;

    if (allPassed) {
      finalStatus.textContent = "All security checks passed. You are ready to start.";
      finalStatus.className = "text-emerald-600 font-semibold text-[15px] flex items-center gap-2";
      btnProceed.disabled = false;
      btnProceed.className = "w-64 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-semibold py-3 rounded-xl shadow-lg shadow-indigo-600/35 hover:shadow-xl hover:shadow-indigo-600/40 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 flex items-center justify-center gap-2.5 cursor-pointer whitespace-nowrap border border-indigo-500/20";
    } else {
      finalStatus.textContent = "Please resolve the security alerts above to proceed.";
      finalStatus.className = "text-rose-500 font-semibold text-[15px]";
      btnProceed.disabled = true;
      btnProceed.className = "w-64 bg-slate-200 text-slate-400 font-semibold py-3 rounded-xl transition-all duration-200 flex items-center justify-center gap-2.5 cursor-not-allowed whitespace-nowrap";
    }
  }

  /**
   * Dynamically renders the agent deep-scan card below the 4 static cards.
   * Returns true if all clear, false if any threat or agent offline.
   */
  function renderAgentCard(agent) {
    // Remove previous agent card
    const existing = document.getElementById("card-agent");
    if (existing) existing.remove();

    // Container where static cards live
    const container = document.querySelector(".flex.flex-col.gap-4");
    if (!container) return true;

    const card = document.createElement("div");
    card.id = "card-agent";

    // ── Agent not running ───────────────────────────────────
    if (!agent || !agent.alive) {
      card.className = "glass-card rounded-2xl p-5 flex flex-col border border-amber-200/50 hover:shadow-md transition-all-custom gap-3";
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-xl bg-amber-50 text-amber-500 flex items-center justify-center border border-amber-200/40 flex-shrink-0">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
            </div>
            <div>
              <h3 class="font-bold text-slate-900 text-[15.5px] leading-tight">Deep Scan Agent</h3>
              <p class="text-amber-600 text-[13px] font-semibold mt-1">Security agent not running — deep behavioral scan unavailable.</p>
            </div>
          </div>
          <div class="text-[12px] font-semibold px-3 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/30">
            Warning
          </div>
        </div>`;
      container.appendChild(card);
      return false; // block proceed if agent is down
    }

    // ── Agent alive, no threats ──────────────────────────────
    const threats = (agent.status && agent.status.threats) || [];
    if (threats.length === 0) {
      card.className = "glass-card rounded-2xl p-5 flex flex-col border border-slate-200/50 hover:shadow-md transition-all-custom gap-3";
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

    // ── Agent alive, threats found ───────────────────────────
    card.className = "glass-card rounded-2xl p-5 flex flex-col border border-rose-200/50 shadow-sm hover:shadow-md transition-all-custom gap-3";

    const threatRows = threats.map(t => `
      <div class="flex items-start gap-3 bg-slate-50/50 rounded-xl px-4 py-2.5 border border-slate-200/30 mt-1.5">
        <span class="relative flex h-2 w-2 mt-1.5 flex-shrink-0">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
        </span>
        <div>
          <span class="text-slate-800 text-sm font-semibold">${t.type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
          <p class="text-slate-500 text-[12px] mt-0.5">${t.detail}</p>
        </div>
        <span class="ml-auto text-[11px] font-bold px-2 py-0.5 rounded-full ${
          t.severity === "HIGH"
            ? "bg-rose-50 text-rose-700 border border-rose-200/40"
            : "bg-amber-50 text-amber-700 border border-amber-200/40"
        }">${t.severity}</span>
      </div>
    `).join("");

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
            <p class="text-rose-700 text-[13px] font-semibold mt-1">${threats.length} behavioral threat${threats.length > 1 ? "s" : ""} detected. Close the applications below and rescan.</p>
          </div>
        </div>
        <div class="text-[12px] font-semibold px-3 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/30 pulse-soft animate-pulse">Action Required</div>
      </div>
      <div class="flex flex-col gap-1 mt-1">${threatRows}</div>`;

    container.appendChild(card);
    return false;
  }

  function updateCard(id, passed, msg, blockedApps = []) {
    const cardEl = document.getElementById(`card-${id}`);
    const iconEl = document.getElementById(`icon-${id}`);
    const descEl = document.getElementById(`desc-${id}`);
    const actionsEl = document.getElementById(`actions-${id}`);
    const badgeEl = document.getElementById(`badge-${id}`);

    // Clear previous action buttons
    if (actionsEl) actionsEl.innerHTML = "";

    if (passed) {
      cardEl.className = "glass-card rounded-2xl p-5 flex flex-col border border-slate-200/50 hover:shadow-md hover:border-slate-300/60 transition-all-custom gap-3";
      iconEl.innerHTML = icons.success;
      iconEl.className = "w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-200/40 shadow-sm flex-shrink-0 transition-all duration-300";
      descEl.textContent = msg;
      descEl.className = "text-slate-500 text-[13px] font-medium mt-1";
      if (badgeEl) {
        badgeEl.className = "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/30";
        badgeEl.textContent = "Ready";
      }
    } else {
      cardEl.className = "glass-card rounded-2xl p-5 flex flex-col border border-rose-200/50 shadow-sm hover:shadow-md hover:border-rose-300/60 transition-all-custom gap-3 glow-red";
      iconEl.innerHTML = icons.error;
      iconEl.className = "w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center border border-rose-200/40 shadow-sm flex-shrink-0 transition-all duration-300";
      descEl.textContent = msg;
      descEl.className = "text-rose-700 text-[13px] font-semibold mt-1";
      if (badgeEl) {
        badgeEl.className = "text-[12px] font-semibold px-3 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200/30 pulse-soft animate-pulse";
        badgeEl.textContent = "Action Required";
      }

      if (blockedApps.length > 0) {
        // Render per-app kill buttons
        blockedApps.forEach(app => {
          const row = document.createElement("div");
          row.className = "flex items-center justify-between bg-slate-50/50 rounded-xl px-4 py-2.5 border border-slate-200/30 mt-1.5 transition-all-custom hover:bg-slate-50";

          const label = document.createElement("div");
          label.className = "flex items-center gap-3";
          label.innerHTML = `
            <span class="relative flex h-2 w-2">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
            </span>
            <div class="flex flex-col">
              <span class="text-slate-800 text-sm font-semibold leading-none">${getDisplayName(app)}</span>
              <span class="text-slate-400 text-[10px] font-medium mt-1.5">${app}</span>
            </div>
          `;

          const btn = document.createElement("button");
          btn.className = "bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-700 font-semibold text-xs py-1.5 px-3.5 rounded-xl border border-rose-200/50 transition-all-custom active:scale-95 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
          btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Close ${getDisplayName(app)}`;
          btn.addEventListener("click", () => handleKillApp(btn, app));

          row.appendChild(label);
          row.appendChild(btn);
          actionsEl.appendChild(row);
        });

        // "Close All & Re-scan" button if multiple apps
        if (blockedApps.length > 1) {
          const closeAllBtn = document.createElement("button");
          closeAllBtn.className = "w-full bg-gradient-to-r from-slate-800 to-slate-900 hover:from-indigo-600 hover:to-indigo-700 text-white font-semibold text-xs py-2.5 px-4 rounded-xl transition-all-custom active:scale-[0.98] flex items-center justify-center gap-2 mt-2 shadow-sm";
          closeAllBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Close All & Re-scan`;
          closeAllBtn.addEventListener("click", () => handleKillAll(closeAllBtn, blockedApps));
          actionsEl.appendChild(closeAllBtn);
        }
      }
    }
  }

  // Kill a single app, show feedback, then auto re-scan only if it was the last active app
  async function handleKillApp(btn, processName) {
    btn.disabled = true;
    btn.className = "bg-amber-50 text-amber-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-amber-200/60 flex items-center gap-1.5 whitespace-nowrap cursor-wait shadow-sm";
    btn.innerHTML = `<svg class="w-3.5 h-3.5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing...`;

    try {
      const result = await window.electronAPI.killProcess(processName);

      if (result.success) {
        btn.className = "bg-emerald-50 text-emerald-700 font-semibold text-xs py-1.5 px-3.5 rounded-xl border border-emerald-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
        btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> Closed`;
        
        // Gray out the process row and neutralize the status indicator dot
        const row = btn.parentElement;
        if (row) {
          row.classList.add("opacity-50", "pointer-events-none");
          const pulsingDot = row.querySelector(".animate-ping");
          if (pulsingDot) pulsingDot.remove();
          const coreDot = row.querySelector(".bg-rose-500");
          if (coreDot) {
            coreDot.className = "relative inline-flex rounded-full h-2 w-2 bg-slate-400";
          }
        }

        // Decrement remaining active processes count
        remainingBlockedApps = Math.max(0, remainingBlockedApps - 1);

        // Auto re-scan after 2 seconds only if the last app was closed
        if (remainingBlockedApps === 0) {
          setTimeout(() => runScans(), 2000);
        }
      } else {
        btn.className = "bg-rose-50 text-rose-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-rose-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
        btn.innerHTML = `❌ Failed — close ${getDisplayName(processName)} manually`;
        btn.disabled = false;
      }
    } catch (e) {
      btn.className = "bg-rose-50 text-rose-600 font-semibold text-xs py-2 px-3.5 rounded-xl border border-rose-200/60 flex items-center gap-1.5 whitespace-nowrap shadow-sm";
      btn.innerHTML = `❌ Error — close ${getDisplayName(processName)} manually`;
      btn.disabled = false;
    }
  }

  // Kill ALL blocked apps, then re-scan
  async function handleKillAll(btn, processNames) {
    btn.disabled = true;
    btn.className = "w-full bg-gradient-to-r from-amber-500 to-amber-600 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md cursor-wait";
    btn.innerHTML = `<svg class="w-4 h-4 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing all apps...`;

    try {
      await window.electronAPI.killAllProcesses(processNames);
      btn.className = "w-full bg-gradient-to-r from-emerald-600 to-emerald-700 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md";
      btn.innerHTML = `✅ All apps closed — re-scanning...`;
    } catch (e) {
      btn.className = "w-full bg-gradient-to-r from-rose-500 to-rose-600 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 mt-3 shadow-md";
      btn.innerHTML = `❌ Some apps failed to close`;
    }

    // Auto re-scan after 2 seconds
    setTimeout(() => runScans(), 2000);
  }

  btnRescan.addEventListener("click", () => {
    runScans();
  });

  btnProceed.addEventListener("click", () => {
    if (window.electronAPI) {
      btnProceed.disabled = true;
      btnProceed.innerHTML = icons.loading + " Loading...";
      window.electronAPI.proceedToInterview();
    }
  });

  // Start initial scan
  runScans();
});
