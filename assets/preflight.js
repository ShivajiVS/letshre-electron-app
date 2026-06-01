document.addEventListener("DOMContentLoaded", () => {
  const btnRescan = document.getElementById("btn-rescan");
  const btnProceed = document.getElementById("btn-proceed");
  const finalStatus = document.getElementById("final-status");

  const icons = {
    loading: '<svg class="w-5 h-5 spinning" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
    success: '<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>',
    error: '<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>'
  };

  const meetingApps = ["zoom.exe", "teams.exe", "webex.exe", "gotomeeting.exe", "skype.exe"];
  const screenSharingApps = ["obs64.exe", "obs32.exe", "discord.exe", "slack.exe", "obs-studio.exe"];
  // Whatever else falls into wireless/remote
  
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
      updateCard("meeting", false, `Close meeting apps: ${foundMeeting.join(", ")}`);
    } else {
      updateCard("meeting", true, "No meeting apps detected.");
    }

    // 3. Screen Sharing
    const foundScreen = procs.filter(p => screenSharingApps.includes(p));
    if (foundScreen.length > 0) {
      allPassed = false;
      updateCard("screen", false, `Close screen sharing: ${foundScreen.join(", ")}`);
    } else {
      updateCard("screen", true, "No screen sharing detected.");
    }

    // 4. Wireless/Remote (Anything else in the array or high res)
    const foundOther = procs.filter(p => !meetingApps.includes(p) && !screenSharingApps.includes(p));
    if (foundOther.length > 0 || (results.mirror.detected && foundMeeting.length === 0 && foundScreen.length === 0)) {
      allPassed = false;
      const extra = foundOther.length > 0 ? foundOther.join(", ") : "Suspicious resolution detected";
      updateCard("wireless", false, `Close remote apps/casting: ${extra}`);
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

  function updateCard(id, passed, msg) {
    const iconEl = document.getElementById(`icon-${id}`);
    const descEl = document.getElementById(`desc-${id}`);

    if (passed) {
      iconEl.innerHTML = icons.success;
      iconEl.className = "w-10 h-10 rounded-full bg-green-500 flex items-center justify-center text-white shadow-sm shadow-green-500/30";
      descEl.textContent = msg;
      descEl.className = "text-slate-500 text-sm font-medium";
    } else {
      iconEl.innerHTML = icons.error;
      iconEl.className = "w-10 h-10 rounded-full bg-red-500 flex items-center justify-center text-white shadow-sm shadow-red-500/30";
      descEl.textContent = msg;
      descEl.className = "text-red-600 text-sm font-semibold";
    }
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
