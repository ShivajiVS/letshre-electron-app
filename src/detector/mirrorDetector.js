const { exec } = require("child_process");

async function detectMirroring() {
  const [processes, resolution] = await Promise.all([
    checkProcesses(),
    checkResolution(),
  ]);

  let detected = false;
  let reason = "";

  // 🔥 Signal 1: Casting / remote apps
  if (processes.found.length > 0) {
    detected = true;
    reason = "Casting/remote apps: " + processes.found.join(", ");
  }

  // 🔥 Signal 2: Abnormal resolution (mirror hint)
  if (resolution.isSuspicious) {
    detected = true;
    reason = resolution.reason;
  }

  return {
    detected,
    reason,
    details: {
      processes: processes.found,
      resolution: resolution.value,
    },
  };
}

// =====================
// PROCESS CHECK (SMART)
// =====================
function checkProcesses() {
  return new Promise((resolve) => {
    const cmd = process.platform === "darwin" ? "ps aux" : "tasklist";
    exec(cmd, (err, stdout) => {
      if (err) return resolve({ found: [] });

      const list = stdout.toLowerCase();

      const suspicious = [
        // Meeting Apps - Windows
        "zoom.exe",
        "teams.exe",
        "ms-teams.exe",
        "msteams.exe",
        "webex.exe",
        "gotomeeting.exe",
        "skype.exe",

        // Meeting Apps - macOS
        "zoom.app",
        "zoom.us.app",
        "teams.app",
        "microsoft teams.app",
        "webex.app",
        "webex meetings.app",
        "gotomeeting.app",
        "skype.app",

        // Screen Sharing / Recording - Windows
        "obs64.exe",
        "obs32.exe",
        "obs-studio.exe",
        "discord.exe",
        "slack.exe",
        "anydesk.exe",
        "teamviewer.exe",
        "bandicam.exe",
        "camtasia.exe",
        "snagit.exe",

        // Screen Sharing / Recording - macOS
        "obs.app",
        "obs studio.app",
        "discord.app",
        "slack.app",
        "anydesk.app",
        "teamviewer.app",
        "camtasia.app",
        "snagit.app",

        // Casting / Mirroring - Windows
        "scrcpy.exe",
        "miracast.exe",
        "apowermirror.exe",
        "letsview.exe",

        // Casting / Mirroring - macOS
        "scrcpy",
        "apowermirror.app",
        "letsview.app",

        // Browsers - Windows
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "opera.exe",
        "brave.exe",
        "vivaldi.exe",

        // Browsers - macOS
        "google chrome.app",
        "microsoft edge.app",
        "firefox.app",
        "safari.app",
        "opera.app",
        "brave.app",
        "vivaldi.app",
      ];

      const found = suspicious.filter((app) => {
        // Use regex to avoid partial suffix/prefix matches (e.g. matching "teams.exe" when only "ms-teams.exe" is running)
        const regex = new RegExp(`(^|\\s|[\\\\/])${app.replace('.', '\\.')}(\\s|[\\\\/]|$)`, 'i');
        return regex.test(stdout);
      });

      resolve({ found });
    });
  });
}

// =====================
// RESOLUTION CHECK
// =====================
function checkResolution() {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      exec("system_profiler SPDisplaysDataType", (err, stdout) => {
        if (err) return resolve({ isSuspicious: false });
        const text = stdout.toLowerCase();
        const is4K = text.includes("3840") || text.includes("2560");
        if (is4K) {
          return resolve({
            isSuspicious: true,
            reason: "High resolution detected (possible mirroring)",
            value: text,
          });
        }
        resolve({ isSuspicious: false, value: text });
      });
      return;
    }

    exec(
      'powershell "Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution,CurrentVerticalResolution"',
      (err, stdout) => {
        if (err) return resolve({ isSuspicious: false });

        const text = stdout.toLowerCase();

        const is4K = text.includes("3840") || text.includes("2560");

        if (is4K) {
          return resolve({
            isSuspicious: true,
            reason: "High resolution detected (possible mirroring)",
            value: text,
          });
        }

        resolve({
          isSuspicious: false,
          value: text,
        });
      },
    );
  });
}

module.exports = detectMirroring;
