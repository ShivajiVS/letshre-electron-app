/**
 * The agent hides the Windows taskbars for the length of an interview and
 * shows them again when the lockdown ends. If the agent was killed before it
 * could (a crash, a forced quit), it leaves a restore file behind, and the
 * candidate has no taskbar until the agent next runs. The agent restores it
 * the moment it starts, so at launch the app starts it just for that, then
 * stops it again unless something now needs it.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const logger = require("./logger");

/** Where agent.py writes TASKBAR_RESTORE_FILE; the two must agree. */
function restoreFilePath(env = process.env) {
  return path.join(
    env.LOCALAPPDATA || os.tmpdir(),
    "letshyre-secure-interview",
    "taskbar-restore.json"
  );
}

/**
 * @param {{
 *   platform?: string,
 *   exists?: (file: string) => boolean,
 *   whenAgentReady: () => Promise<boolean>,
 *   killAgent: () => void,
 *   agentStillWanted: () => boolean,
 * }} deps
 * @returns {Promise<boolean>} whether a restore was attempted
 */
async function recoverHiddenTaskbar({
  platform = process.platform,
  exists = fs.existsSync,
  whenAgentReady,
  killAgent,
  agentStillWanted,
}) {
  if (platform !== "win32" || !exists(restoreFilePath())) {
    return false;
  }
  logger.warn(
    "[lockdown] taskbar left hidden by an earlier run — starting the agent to restore it"
  );
  const ready = await whenAgentReady();
  if (!ready) {
    logger.warn("[lockdown] agent didn't start; the taskbar is restored when it next does");
  }
  if (!agentStillWanted()) {
    killAgent();
  }
  return true;
}

module.exports = { restoreFilePath, recoverHiddenTaskbar };
