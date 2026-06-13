/**
 * src/main/agentManager.js
 * ────────────────────────
 * Owns the full lifecycle of the Python security agent binary:
 *   - Resolving the binary path (packaged vs. dev)
 *   - Spawning the process
 *   - Polling until ready
 *   - Cleaning up on exit
 */

"use strict";

const path = require("path");
const http = require("http");
const { app } = require("electron");
const { spawn } = require("child_process");
const logger = require("./logger");
const {
  AGENT_HOST,
  AGENT_PORT,
  AGENT_PING_TIMEOUT_MS,
  AGENT_POLL_INTERVAL_MS,
} = require("../shared/constants");

/** @type {import("child_process").ChildProcess | null} */
let agentProcess = null;

/**
 * Resolves the absolute path to the agent binary,
 * handling both packaged (production) and development environments.
 * @returns {string}
 */
function getAgentPath() {
  const binName = process.platform === "win32" ? "agent.exe" : "agent";
  if (app.isPackaged) {
    return path.join(process.resourcesPath, binName);
  }
  return path.join(__dirname, "../../resources", binName);
}

/**
 * Spawns the Python security agent binary and keeps a reference to it.
 * Logs stdout/stderr and clears the reference on exit.
 */
function spawnAgent() {
  const agentPath = getAgentPath();
  try {
    agentProcess = spawn(agentPath, [], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    agentProcess.stdout.on("data", (d) =>
      logger.info("[agent]", d.toString().trim())
    );
    agentProcess.stderr.on("data", (d) =>
      logger.error("[agent:err]", d.toString().trim())
    );
    agentProcess.on("exit", (code) => {
      logger.warn(`[agent] exited with code ${code}`);
      agentProcess = null;
    });

    logger.info("[agent] spawned from", agentPath);
  } catch (err) {
    logger.error("[agent] failed to spawn:", err.message);
  }
}

/**
 * Polls /ping every AGENT_POLL_INTERVAL_MS for up to maxMs milliseconds.
 * @param {number} [maxMs]
 * @returns {Promise<boolean>} Resolves true if agent responds, false on timeout.
 */
function waitForAgent(maxMs = AGENT_PING_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();

    function attempt() {
      const req = http.get(
        { host: AGENT_HOST, port: AGENT_PORT, path: "/ping", timeout: 400 },
        (res) => {
          resolve(res.statusCode === 200);
        }
      );
      req.setTimeout(400, () => {
        req.destroy();
        if (Date.now() - started < maxMs) {
          setTimeout(attempt, AGENT_POLL_INTERVAL_MS);
        } else {
          logger.warn("[agent] did not respond within", maxMs, "ms");
          resolve(false);
        }
      });
      req.on("error", () => {
        if (Date.now() - started < maxMs) {
          setTimeout(attempt, AGENT_POLL_INTERVAL_MS);
        } else {
          resolve(false);
        }
      });
    }

    attempt();
  });
}

/**
 * Terminates the agent process if it is running.
 * Called during app `will-quit`.
 */
function killAgent() {
  if (agentProcess) {
    try {
      agentProcess.kill();
      logger.info("[agent] terminated cleanly");
    } catch (err) {
      logger.warn("[agent] kill failed:", err.message);
    }
    agentProcess = null;
  }
}

module.exports = { spawnAgent, waitForAgent, killAgent, getAgentPath };
