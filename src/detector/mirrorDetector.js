const { exec } = require('child_process');

async function detectMirroring() {

  const [processes, resolution] = await Promise.all([
    checkProcesses(),
    checkResolution()
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
      resolution: resolution.value
    }
  };
}


// =====================
// PROCESS CHECK (SMART)
// =====================
function checkProcesses() {
  return new Promise((resolve) => {

    exec('tasklist', (err, stdout) => {

      if (err) return resolve({ found: [] });

      const list = stdout.toLowerCase();

      const suspicious = [
        "zoom.exe",
        "teams.exe",
        "obs64.exe",
        "anydesk.exe",
        "teamviewer.exe",
        "chrome.exe",       // casting
        "msedge.exe",       // casting
        "firefox.exe",
        "scrcpy.exe",       // mobile mirroring
        "miracast.exe"
      ];

      const found = suspicious.filter(app => list.includes(app));

      resolve({ found });
    });

  });
}


// =====================
// RESOLUTION CHECK
// =====================
function checkResolution() {
  return new Promise((resolve) => {

    exec(
      'powershell "Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution,CurrentVerticalResolution"',
      (err, stdout) => {

        if (err) return resolve({ isSuspicious: false });

        const text = stdout.toLowerCase();

        const is4K =
          text.includes("3840") ||
          text.includes("2560");

        if (is4K) {
          return resolve({
            isSuspicious: true,
            reason: "High resolution detected (possible mirroring)",
            value: text
          });
        }

        resolve({
          isSuspicious: false,
          value: text
        });
      }
    );

  });
}


module.exports = detectMirroring;