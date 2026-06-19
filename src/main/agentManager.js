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
const { app } = require("electron");
const { spawn } = require("child_process");
const logger = require("./logger");
const appState = require("./appState");
const {
  AGENT_PORT,
  AGENT_PING_TIMEOUT_MS,
  AGENT_POLL_INTERVAL_MS,
  AGENT_REQUEST_TIMEOUT_MS,
} = require("../shared/constants");

const crypto = require("crypto");
const AGENT_SECRET = crypto.randomBytes(16).toString("hex");

function getAgentSecret() {
  return AGENT_SECRET;
}

/** @type {import("child_process").ChildProcess | null} */
let agentProcess = null;

// ─── Pipe protocol state (Phase 2) ───────────────────────────────────────────
// Electron talks to the agent over stdin/stdout using newline-delimited JSON.
// Each request carries an incrementing id; responses are matched back by id.
let _cmdId = 0;
const _pending = new Map(); // id → { resolve, timer }
let _stdoutBuf = ""; // accumulates partial stdout lines

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
 * Returns how to spawn the agent: { command, args }.
 * Set AGENT_PY=1 to run the Python source directly (python agent.py) instead of
 * the bundled binary — useful in development so agent.py changes take effect
 * without a PyInstaller rebuild.
 * @returns {{ command: string, args: string[] }}
 */
function getAgentSpawn() {
  if (!app.isPackaged && process.env.AGENT_PY) {
    const py = process.env.AGENT_PY_BIN || (process.platform === "win32" ? "python" : "python3");
    return { command: py, args: [path.join(__dirname, "../../agent.py")] };
  }
  return { command: getAgentPath(), args: [] };
}

/**
 * Parses any complete JSON lines buffered from the agent's stdout and resolves
 * the matching pending command promises.
 * @param {string} chunk
 */
function _consumeStdout(chunk) {
  _stdoutBuf += chunk;
  let nl;
  while ((nl = _stdoutBuf.indexOf("\n")) !== -1) {
    const line = _stdoutBuf.slice(0, nl).trim();
    _stdoutBuf = _stdoutBuf.slice(nl + 1);
    if (!line) { continue; }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not protocol JSON (shouldn't happen — logs go to stderr). Ignore.
      continue;
    }
    const entry = _pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      _pending.delete(msg.id);
      entry.resolve(msg);
    }
  }
}

/**
 * Sends one command to the agent over the pipe and resolves with its parsed
 * response, or null on timeout / no agent / write failure. Never rejects.
 * @param {"ping"|"status"|"scan"|"log"} cmd
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>}
 */
function sendAgentCommand(cmd, timeoutMs = AGENT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!agentProcess || !agentProcess.stdin || !agentProcess.stdin.writable) {
      return resolve(null);
    }
    const id = ++_cmdId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve(null);
    }, timeoutMs);
    _pending.set(id, { resolve, timer });
    try {
      agentProcess.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
    } catch {
      clearTimeout(timer);
      _pending.delete(id);
      resolve(null);
    }
  });
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

  const { command, args } = getAgentSpawn();
  try {
    // Phase 2: stdin is now piped so we can send commands. stdout carries the
    // JSON protocol (parsed by _consumeStdout); stderr carries the agent's logs.
    agentProcess = spawn(command, args, {
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
      // IMP-08: Direct the agent to write its log to userData (writable in all modes).
      // IMP-12: Pass the canonical app version so agent doesn't need its own version string.
      env: {
        ...process.env,
        AGENT_LOG_DIR: app.getPath("userData"),
        APP_VERSION: app.getVersion(),
        AGENT_SECRET: AGENT_SECRET,
      },
    });

    agentProcess.stdout.on("data", (d) => _consumeStdout(d.toString()));
    // stderr is the agent's normal log channel now (logs moved off stdout).
    agentProcess.stderr.on("data", (d) =>
      logger.info("[agent]", d.toString().trim())
    );
    agentProcess.on("exit", (code) => {
      logger.warn(`[agent] exited with code ${code}`);
      agentProcess = null;
      // Fail any in-flight commands so callers don't hang until timeout.
      for (const [, entry] of _pending) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
      _pending.clear();
      _stdoutBuf = "";

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

    logger.info("[agent] spawned:", command, args.join(" "));
  } catch (err) {
    logger.error("[agent] failed to spawn:", err.message);
  }
}

// ─── Wait / Poll ─────────────────────────────────────────────────────────────

/**
 * Pings the agent over the pipe every AGENT_POLL_INTERVAL_MS until it responds
 * or maxMs elapses. No longer depends on the HTTP port being reachable.
 * @param {number} [maxMs]
 * @returns {Promise<boolean>} Resolves true if agent responds, false on timeout.
 */
async function waitForAgent(maxMs = AGENT_PING_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const res = await sendAgentCommand("ping", 400);
    if (res && res.alive) { return true; }
    await new Promise((r) => setTimeout(r, AGENT_POLL_INTERVAL_MS));
  }
  logger.warn("[agent] did not respond within", maxMs, "ms");
  return false;
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
  sendAgentCommand,
};
