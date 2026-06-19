/**
 * src/main/agentManager.js
 * ────────────────────────
 * Owns the full lifecycle of the Python security agent binary:
 *   - Resolving the binary path (packaged vs. dev)
 *   - Killing stale instances from previous crashes
 *   - Spawning the process
 *   - Auto-respawning on unexpected exit
 *   - Polling until ready
 *   - Cleaning up on exit
 */

"use strict";

const path = require("path");
const http = require("http");
const { app } = require("electron");
const { spawn } = require("child_process");
const logger = require("./logger");
const appState = require("./appState");
const {
  AGENT_HOST,
  AGENT_PORT,
  AGENT_PING_TIMEOUT_MS,
  AGENT_POLL_INTERVAL_MS,
} = require("../shared/constants");

const crypto = require("crypto");
const AGENT_SECRET = crypto.randomBytes(16).toString("hex");

function getAgentSecret() {
  return AGENT_SECRET;
}

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

// ─── Stale Agent Cleanup ─────────────────────────────────────────────────────

/**
 * Kills any stale agent process occupying the agent port.
 * This handles the case where a previous Electron crash left an orphaned
 * agent.exe still bound to port 9999, preventing a new instance from starting.
 *
 * Cross-platform: uses `netstat` + `taskkill` on Windows, `lsof` + `kill` on macOS/Linux.
 * @returns {Promise<void>}
 */
function killStaleAgent() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Step 1: Kill all agent.exe by image name (safe — we haven't spawned ours yet)
      const killByName = spawn("taskkill", ["/IM", "agent.exe", "/F"], { shell: false });
      killByName.on("close", () => {
        // Step 2: Fallback — kill anything else on the agent port
        // Use PowerShell for reliable netstat parsing (cmd /c for is fragile)
        const psCmd = `
          $lines = netstat -aon | Select-String ':${AGENT_PORT}.*LISTENING';
          foreach ($line in $lines) {
            $pid = ($line -split '\\s+')[-1];
            if ($pid -and $pid -ne '0') {
              taskkill /PID $pid /F 2>$null;
            }
          }
        `;
        const killByPort = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { shell: false });
        killByPort.on("close", () => setTimeout(resolve, 500));
        killByPort.on("error", () => resolve());
      });
      killByName.on("error", () => resolve());
    } else {
      // macOS / Linux: find PID(s) via lsof
      const findProc = spawn("lsof", ["-ti", `:${AGENT_PORT}`], {
        shell: false,
      });

      let stdout = "";
      findProc.stdout.on("data", (d) => (stdout += d.toString()));
      findProc.on("close", () => {
        const pids = stdout
          .trim()
          .split(/\s+/)
          .filter((p) => p && p !== "0");
        if (pids.length === 0) return resolve();

        logger.info(
          `[agent] killing stale agent(s) on port ${AGENT_PORT}: PIDs ${pids.join(", ")}`
        );
        const kills = pids.map(
          (pid) =>
            new Promise((res) => {
              const kp = spawn("kill", ["-9", pid], { shell: false });
              kp.on("close", res);
              kp.on("error", res);
            })
        );
        Promise.all(kills).then(() => setTimeout(resolve, 500));
      });
      findProc.on("error", () => resolve());
    }
  });
}

// ─── Spawn ───────────────────────────────────────────────────────────────────

/**
 * Spawns the Python security agent binary and keeps a reference to it.
 * Kills any stale orphaned agent first, then spawns fresh.
 * Logs stdout/stderr and auto-respawns on unexpected exit.
 */
async function spawnAgent() {
  // Kill any orphaned agent from a previous crash
  await killStaleAgent();

  const agentPath = getAgentPath();
  try {
    agentProcess = spawn(agentPath, [], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      // IMP-08: Direct the agent to write its log to userData (writable in all modes).
      // IMP-12: Pass the canonical app version so agent doesn't need its own version string.
      env: {
        ...process.env,
        AGENT_LOG_DIR: app.getPath("userData"),
        APP_VERSION: app.getVersion(),
        AGENT_SECRET: AGENT_SECRET,
      },
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

      // Auto-respawn if the agent died unexpectedly (not during app shutdown)
      if (code !== 0 && !appState.isQuitting()) {
        logger.info("[agent] scheduling auto-respawn in 2s...");
        setTimeout(() => {
          if (!appState.isQuitting()) {
            logger.info("[agent] respawning...");
            spawnAgent();
          }
        }, 2000);
      }
    });

    logger.info("[agent] spawned from", agentPath);
  } catch (err) {
    logger.error("[agent] failed to spawn:", err.message);
  }
}

// ─── Wait / Poll ─────────────────────────────────────────────────────────────

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

// ─── Cleanup ─────────────────────────────────────────────────────────────────

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

module.exports = {
  spawnAgent,
  waitForAgent,
  killAgent,
  getAgentPath,
  getAgentSecret,
};
