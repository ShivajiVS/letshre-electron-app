document.addEventListener("DOMContentLoaded", () => {
  const btnRescan = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");

  const icons = {
    loading: '<svg class="w-5 h-5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
    success: '<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
    error: '<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>'
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
    btnProceed.className = "bg-slate-100 text-slate-400 font-bold py-3.5 px-8 rounded-xl border border-slate-200 transition-all flex items-center justify-center gap-3 cursor-not-allowed whitespace-nowrap";
    btnRescan.disabled = true;
    finalStatus.textContent = "Running security diagnostics...";
    finalStatus.className = "text-slate-500 font-medium";

    ["hdmi", "meeting", "screen", "wireless"].forEach(id => {
      document.getElementById(`icon-${id}`).innerHTML = icons.loading;
      document.getElementById(`icon-${id}`).className = "w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400";
      // Clear previous action buttons
      const actionsEl = document.getElementById(`actions-${id}`);
      if (actionsEl) actionsEl.innerHTML = "";
    });
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

    // 4. Wireless/Remote (Anything else in the array or high res)
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

    btnRescan.disabled = false;

    if (allPassed) {
      finalStatus.textContent = "All checks passed. You may proceed.";
      finalStatus.className = "text-green-600 font-semibold";
      btnProceed.disabled = false;
      btnProceed.className = "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold py-3.5 px-8 rounded-xl shadow-lg shadow-indigo-500/40 active:scale-[0.97] transition-all flex items-center justify-center gap-3 cursor-pointer whitespace-nowrap border border-indigo-500/20";
    } else {
      finalStatus.textContent = "All issues must be resolved before proceeding.";
      finalStatus.className = "text-red-500 font-semibold";
    }
  }

  function updateCard(id, passed, msg, blockedApps = []) {
    const iconEl = document.getElementById(`icon-${id}`);
    const descEl = document.getElementById(`desc-${id}`);
    const actionsEl = document.getElementById(`actions-${id}`);

    // Clear previous action buttons
    if (actionsEl) actionsEl.innerHTML = "";

    if (passed) {
      iconEl.innerHTML = icons.success;
      iconEl.className = "w-10 h-10 rounded-full bg-green-500 flex items-center justify-center text-white shadow-sm shadow-green-500/30";
      descEl.textContent = msg;
      descEl.className = "text-slate-500 text-sm font-medium";
    } else {
      iconEl.innerHTML = icons.error;
      iconEl.className = "w-10 h-10 rounded-full bg-red-500 flex items-center justify-center text-white shadow-sm shadow-red-500/30";
      descEl.className = "text-red-600 text-sm font-semibold";

      if (blockedApps.length > 0) {
        // Show explanation that apps are running in background
        descEl.innerHTML = `<span class="block mb-1">⚠️ ${msg}</span><span class="text-slate-500 text-xs font-normal">You may have closed the window, but the app is still running in the background. Use the buttons below to force close them.</span>`;

        // Render per-app kill buttons
        blockedApps.forEach(app => {
          const row = document.createElement("div");
          row.className = "flex items-center justify-between bg-white rounded-lg px-3 py-2.5 border border-red-100 shadow-sm";

          const label = document.createElement("div");
          label.className = "flex items-center gap-2";
          label.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-400 inline-block"></span><span class="text-slate-700 text-sm font-medium">${getDisplayName(app)}</span><span class="text-slate-400 text-xs">(${app})</span>`;

          const btn = document.createElement("button");
          btn.className = "bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-xs py-1.5 px-3 rounded-lg border border-red-200 transition-all active:scale-95 flex items-center gap-1.5 whitespace-nowrap";
          btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg> Close ${getDisplayName(app)}`;
          btn.addEventListener("click", () => handleKillApp(btn, app));

          row.appendChild(label);
          row.appendChild(btn);
          actionsEl.appendChild(row);
        });

        // "Close All & Re-scan" button if multiple apps
        if (blockedApps.length > 1) {
          const closeAllBtn = document.createElement("button");
          closeAllBtn.className = "w-full bg-slate-800 hover:bg-slate-900 text-white font-semibold text-sm py-2.5 px-4 rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 mt-1 shadow-sm";
          closeAllBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Close All & Re-scan`;
          closeAllBtn.addEventListener("click", () => handleKillAll(closeAllBtn, blockedApps));
          actionsEl.appendChild(closeAllBtn);
        }
      } else {
        // No killable apps (e.g. resolution issue) — just show the message
        descEl.textContent = msg;
      }
    }
  }

  // Kill a single app, show feedback, then auto re-scan
  async function handleKillApp(btn, processName) {
    btn.disabled = true;
    btn.className = "bg-amber-50 text-amber-600 font-semibold text-xs py-1.5 px-3 rounded-lg border border-amber-200 flex items-center gap-1.5 whitespace-nowrap cursor-wait";
    btn.innerHTML = `<svg class="w-3.5 h-3.5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing...`;

    try {
      const result = await window.electronAPI.killProcess(processName);

      if (result.success) {
        btn.className = "bg-green-50 text-green-700 font-semibold text-xs py-1.5 px-3 rounded-lg border border-green-200 flex items-center gap-1.5 whitespace-nowrap";
        btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg> ${getDisplayName(processName)} closed`;
      } else {
        btn.className = "bg-red-50 text-red-600 font-semibold text-xs py-1.5 px-3 rounded-lg border border-red-200 flex items-center gap-1.5 whitespace-nowrap";
        btn.innerHTML = `❌ Failed — close ${getDisplayName(processName)} manually`;
        btn.disabled = false;
      }
    } catch (e) {
      btn.className = "bg-red-50 text-red-600 font-semibold text-xs py-1.5 px-3 rounded-lg border border-red-200 flex items-center gap-1.5 whitespace-nowrap";
      btn.innerHTML = `❌ Error — close ${getDisplayName(processName)} manually`;
      btn.disabled = false;
    }

    // Auto re-scan after 2 seconds to verify
    setTimeout(() => runScans(), 2000);
  }

  // Kill ALL blocked apps, then re-scan
  async function handleKillAll(btn, processNames) {
    btn.disabled = true;
    btn.className = "w-full bg-amber-500 text-white font-semibold text-sm py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 mt-1 shadow-sm cursor-wait";
    btn.innerHTML = `<svg class="w-4 h-4 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Closing all apps...`;

    try {
      await window.electronAPI.killAllProcesses(processNames);
      btn.className = "w-full bg-green-600 text-white font-semibold text-sm py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 mt-1 shadow-sm";
      btn.innerHTML = `✅ All apps closed — re-scanning...`;
    } catch (e) {
      btn.className = "w-full bg-red-500 text-white font-semibold text-sm py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 mt-1 shadow-sm";
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
