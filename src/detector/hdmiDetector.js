const { exec } = require('child_process');

// 🔥 Detect PHYSICAL connected monitors (bypasses "Duplicate Screen" loophole)
function getMonitors() {
  return new Promise((resolve) => {
    exec(
      'powershell "(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID).InstanceName"',
      (err, stdout) => {
        if (err) return resolve([]);

        const lines = stdout
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 0);

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
          .filter(l => l && !l.includes("Name") && !l.startsWith("---"));

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
    reason = `Multiple monitors detected (${monitors.length} active displays)`;
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