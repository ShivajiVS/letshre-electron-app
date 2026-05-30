const { exec } = require('child_process');

// 🔥 Detect connected monitors using WMI
function getMonitors() {
  return new Promise((resolve) => {
    exec(
      'powershell "Get-CimInstance Win32_DesktopMonitor | Select-Object Name,PNPDeviceID"',
      (err, stdout) => {
        if (err) return resolve([]);

        const lines = stdout
          .split("\n")
          .map(l => l.trim())
          .filter(l => l && !l.includes("Name"));

        resolve(lines);
      }
    );
  });
}


// 🔥 Detect display adapters (GPU outputs)
function getVideoControllers() {
  return new Promise((resolve) => {
    exec(
      'powershell "Get-CimInstance Win32_VideoController | Select-Object Name,VideoModeDescription"',
      (err, stdout) => {
        if (err) return resolve([]);

        const lines = stdout
          .split("\n")
          .map(l => l.trim())
          .filter(l => l && !l.includes("Name"));

        resolve(lines);
      }
    );
  });
}


// 🔥 MAIN DETECTION
async function detectHDMIWindows() {
  const monitors = await getMonitors();
  const controllers = await getVideoControllers();

  let isExternal = false;
  let reason = "";

  // 🔥 Heuristic 1: Multiple monitors
  if (monitors.length > 1) {
    isExternal = true;
    reason = "Multiple monitors detected via WMI";
  }

  // 🔥 Heuristic 2: High resolution modes (4K etc.)
  const highRes = controllers.some(c =>
    c.toLowerCase().includes("2560") ||
    c.toLowerCase().includes("3840")
  );

  if (highRes) {
    isExternal = true;
    reason = "High resolution display detected";
  }

  return {
    detected: isExternal,
    monitors,
    controllers,
    reason
  };
}

module.exports = { detectHDMIWindows };