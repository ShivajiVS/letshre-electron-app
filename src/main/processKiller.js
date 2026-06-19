/**
 * src/main/processKiller.js
 * ─────────────────────────
 * Force-terminates blocked background processes by name.
 *
 * Only processes in ALL_BLOCKED_APPS (from src/shared/appList.js) may be
 * killed — all others are rejected. This whitelist prevents the IPC handler
 * from being abused to kill arbitrary OS processes.
 */

"use strict";

const { exec, spawn } = require("child_process");
const logger = require("./logger");
const { ALL_BLOCKED_APPS } = require("../shared/appList");

// ─── Self-Protection Guard ───────────────────────────────────────────────────

/**
 * Returns true if the given process name matches our own Electron app.
 * Handles version-suffixed names (e.g. "LetsHyre Secure Interview 1.0.0.exe").
 *
 * Windows: electron-builder produces "LetsHyre Secure Interview.exe"
 *          and version-suffixed "LetsHyre Secure Interview 1.0.0.exe".
 * macOS:   "LetsHyre Secure Interview.app" or "letshyre-secure-interview".
 * Dev:     "electron.exe" / "electron".
 */
function isOwnProcess(processName) {
  const name = processName.toLowerCase();

  // Prefix matches — covers version-suffixed names and .app/.exe extensions
  const OWN_PREFIXES = [
    "letshyre secure interview", // matches with or without version suffix
    "letshyre-secure-interview", // npm/bundle name variant
  ];

  // Exact matches for dev mode and agent process
  const OWN_EXACT = ["electron.exe", "electron", "agent.exe", "agent"];

  if (OWN_EXACT.includes(name)) return true;
  return OWN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// ─── Kill Logic ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ success: boolean, processName: string, error?: string }} KillResult
 */

/**
 * Force-terminates a single process by name.
 * Rejects with an error object if the name is not on the blocked list.
 * @param {string} processName
 * @returns {Promise<KillResult>}
 */
function killSingleProcess(processName) {
  return new Promise((resolve) => {
    // Self-protection: never kill our own Electron app
    if (isOwnProcess(processName)) {
      logger.warn("[processKiller] blocked attempt to kill own process:", processName);
      return resolve({
        success: false,
        error: "Cannot kill own process",
        processName,
      });
    }

    if (!ALL_BLOCKED_APPS.includes(processName.toLowerCase())) {
      logger.warn("[processKiller] rejected attempt to kill non-blocked process:", processName);
      return resolve({
        success: false,
        error: "Process not in blocked list",
        processName,
      });
    }

    // Use spawn() instead of exec() — no shell invocation, no injection risk.
    let killProc;
    if (process.platform === "darwin") {
      const appName = processName.replace(".app", "");
      // Use -x for exact match to avoid killing our own app via partial match
      killProc = spawn("pkill", ["-x", "-f", appName], { shell: false });
    } else {
      // /IM <name> /F — args passed directly, no shell parsing
      // NOTE: /T (tree-kill) is intentionally omitted to prevent cascading
      // kills that can terminate the Electron app when it shares a process
      // tree with the target (e.g. browser processes).
      killProc = spawn("taskkill", ["/IM", processName, "/F"], { shell: false });
    }

    killProc.on("close", () => {
      // Multi-process apps (Chrome, Teams, Zoom) spawn many child processes.
      // After taskkill /F, children take ~300–700ms to fully exit.
      // Checking immediately causes false "Failed" results — add delay + retry.
      const verify = (attempt, delay) =>
        setTimeout(() => {
          const verifyProc = process.platform === "darwin"
            ? spawn("pgrep", ["-f", processName.replace(".app", "")], { shell: false })
            : spawn("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/NH"], { shell: false });

          let stdout = "";
          verifyProc.stdout.on("data", (d) => (stdout += d.toString()));
          verifyProc.on("close", () => {
            const stillRunning = stdout.toLowerCase().includes(processName.toLowerCase());

            if (!stillRunning) {
              logger.info(`[processKiller] confirmed ${processName} is gone (attempt ${attempt})`);
              resolve({ success: true, processName });
            } else if (attempt < 2) {
              // One retry after a further 600ms — handles slow-dying child processes
              logger.info(`[processKiller] ${processName} still visible, retrying…`);
              verify(attempt + 1, 600);
            } else {
              logger.warn(`[processKiller] ${processName} still running after kill — may need admin rights`);
              resolve({ success: false, error: "Process still running — may require admin rights", processName });
            }
          });
        }, delay);

      // First check after 700ms — gives OS time to reap all child processes
      verify(1, 700);
    });

    killProc.on("error", (err) => {
      logger.warn(`[processKiller] spawn error for ${processName}:`, err.message);
      resolve({ success: false, error: err.message, processName });
    });
  });
}

/**
 * Force-terminates all provided processes in parallel.
 * Uses Promise.all() so 5 apps are killed simultaneously, not sequentially.
 * @param {string[]} processNames
 * @returns {Promise<KillResult[]>}
 */
async function killAllProcesses(processNames) {
  return await Promise.all(processNames.map((name) => killSingleProcess(name)));
}

module.exports = { killSingleProcess, killAllProcesses };

