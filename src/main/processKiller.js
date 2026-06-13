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

const { exec } = require("child_process");
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

    let cmd;
    if (process.platform === "darwin") {
      const appName = processName.replace(".app", "");
      cmd = `pkill -f "${appName}"`;
    } else {
      cmd = `taskkill /IM "${processName}" /F /T`;
    }

    exec(cmd, (err) => {
      if (err) {
        logger.warn(`[processKiller] failed to kill ${processName}:`, err.message);
        resolve({ success: false, error: err.message, processName });
      } else {
        logger.info(`[processKiller] successfully killed ${processName}`);
        resolve({ success: true, processName });
      }
    });
  });
}

/**
 * Force-terminates all provided processes sequentially.
 * @param {string[]} processNames
 * @returns {Promise<KillResult[]>}
 */
async function killAllProcesses(processNames) {
  const results = [];
  for (const name of processNames) {
    results.push(await killSingleProcess(name));
  }
  return results;
}

module.exports = { killSingleProcess, killAllProcesses };
