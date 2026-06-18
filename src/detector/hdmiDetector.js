const { execFile } = require('child_process');

// 🔥 Detect PHYSICAL connected monitors (bypasses "Duplicate Screen" loophole)
function getMonitors() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('system_profiler', ['SPDisplaysDataType'], (err, stdout) => {
        if (err) {return resolve([]);}
        const displays = stdout.split('\n').filter(l => l.includes('Resolution:')).length;
        resolve(Array.from({length: displays}, (_, i) => `Mac_Display_${i+1}`));
      });
      return;
    }

    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID).InstanceName"
    ], (err, stdout) => {
        if (err) {return resolve([]);}

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
    if (process.platform === 'darwin') {
      execFile('system_profiler', ['SPDisplaysDataType'], (err, stdout) => {
        if (err) {return resolve([]);}
        const lines = stdout
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.includes("Resolution:"));
        resolve(lines);
      });
      return;
    }

    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,VideoModeDescription"
    ], (err, stdout) => {
        if (err) {return resolve([]);}

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

  const multipleMonitors = monitors.length > 1;

  // 🔥 Heuristic 1: Multiple physical monitors — always flag
  if (multipleMonitors) {
    isExternal = true;
    reason = `Multiple monitors detected (${monitors.length} active displays)`;
  }

  // 🔥 Heuristic 2: High resolution — only flag if ALSO multiple monitors.
  // Many modern laptops have built-in QHD (2560) or 4K (3840) screens,
  // so resolution alone is NOT a reliable signal for an external display.
  const highRes = controllers.some(
    (c) =>
      c.toLowerCase().includes("2560") || c.toLowerCase().includes("3840")
  );

  if (highRes && multipleMonitors && !isExternal) {
    isExternal = true;
    reason = `High resolution display detected with multiple monitors (${monitors.length} active)`;
  }

  return {
    detected: isExternal,
    monitors,
    controllers,
    reason,
  };
}

module.exports = { detectHDMIWindows };