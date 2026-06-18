const { exec } = require("child_process");
const { ALL_BLOCKED_APPS } = require("../shared/appList");

async function detectMirroring() {
  const [processes, resolution] = await Promise.all([
    checkProcesses(),
    checkResolution(),
  ]);

  let detected = false;
  let reason = "";

  // 🔥 Signal 1: Casting / remote apps running
  if (processes.found.length > 0) {
    detected = true;
    reason = `Casting/remote apps: ${  processes.found.join(", ")}`;
  }

  // 🔥 Signal 2: High resolution + multiple monitors (cross-reference required)
  // Resolution alone is NOT a reliable mirroring signal — modern laptops
  // (MacBook Pro, Dell XPS, Surface) have native QHD/4K screens.
  // Only flag when resolution AND monitor count are both anomalous.
  if (resolution.isSuspicious && !detected) {
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
    const { execFile } = require("child_process");
    const [bin, ...args] = process.platform === "darwin" ? ["ps", "aux"] : ["tasklist"];
    execFile(bin, args, (err, stdout) => {
      if (err) {return resolve({ found: [] });}

      // Source of truth: src/shared/appList.js
      const suspicious = ALL_BLOCKED_APPS;

      const found = suspicious.filter((app) => {
        // Use regex to avoid partial matches (e.g. "teams.exe" vs "ms-teams.exe")
        const regex = new RegExp(
          `(^|\\s|[\\\\/])${app.replace(".", "\\.")}(\\s|[\\\\/]|$)`,
          "i"
        );
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
    const { execFile } = require("child_process");
    if (process.platform === "darwin") {
      execFile("system_profiler", ["SPDisplaysDataType"], (err, stdout) => {
        if (err) {return resolve({ isSuspicious: false });}

        // Count displays — only flag resolution if multiple monitors are present
        const displayCount = (stdout.match(/Resolution:/g) || []).length;
        const text = stdout.toLowerCase();
        const is4K = text.includes("3840") || text.includes("2560");

        if (is4K && displayCount > 1) {
          return resolve({
            isSuspicious: true,
            reason: `High-resolution multi-monitor setup detected (${displayCount} displays — possible mirroring)`,
            value: text,
          });
        }
        resolve({ isSuspicious: false, value: text });
      });
      return;
    }

    // Windows: get both resolution and monitor count in one call
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution,CurrentVerticalResolution; (Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID).Count"
    ], (err, stdout) => {
        if (err) {return resolve({ isSuspicious: false });}

        const text = stdout.toLowerCase();
        const is4K = text.includes("3840") || text.includes("2560");

        // Extract monitor count from last non-empty line
        const lines = stdout.trim().split("\n").map(l => l.trim()).filter(Boolean);
        const lastLine = lines[lines.length - 1];
        const monitorCount = parseInt(lastLine, 10) || 1;

        // Flag only if high-res AND multiple monitors — single 4K laptop is fine
        if (is4K && monitorCount > 1) {
          return resolve({
            isSuspicious: true,
            reason: `High-resolution multi-monitor setup detected (${monitorCount} monitors — possible mirroring)`,
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
