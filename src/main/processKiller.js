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
      killProc = spawn("pkill", ["-f", appName], { shell: false });
    } else {
      // /IM <name> /F /T — args passed directly, no shell parsing
      killProc = spawn("taskkill", ["/IM", processName, "/F", "/T"], { shell: false });
    }

    killProc.on("close", () => {
      // Verify the process is actually gone after the kill attempt.
      // Do NOT rely on taskkill exit code — it can be non-zero even on partial success.
      const checkCmd =
        process.platform === "darwin"
          ? `pgrep -f "${processName.replace(".app", "")}"`
          : `tasklist /FI "IMAGENAME eq ${processName}" /NH`;

      exec(checkCmd, (_err, stdout) => {
        const stillRunning = stdout
          .toLowerCase()
          .includes(processName.toLowerCase());

        if (!stillRunning) {
          logger.info(`[processKiller] confirmed ${processName} is gone`);
          resolve({ success: true, processName });
        } else {
          logger.warn(`[processKiller] ${processName} still running after kill attempt`);
          resolve({ success: false, error: "Process still running — may require admin rights", processName });
        }
      });
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
