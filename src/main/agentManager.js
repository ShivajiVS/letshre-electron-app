/** Lifecycle of the Python security agent: spawn, readiness, respawn and shutdown. */

"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { spawn } = require("child_process");
const logger = require("./logger");
const appState = require("./appState");
const {
  AGENT_PORT,
  AGENT_POLL_INTERVAL_MS,
  AGENT_READY_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_MS,
  AGENT_RESPAWN_BASE_MS,
  AGENT_RESPAWN_MAX_MS,
  AGENT_STABLE_UPTIME_MS,
} = require("../shared/constants");
const { agentSourceMatches, expectedAgentSource } = require("../shared/agentBuild");

const crypto = require("crypto");
const AGENT_SECRET = crypto.randomBytes(16).toString("hex");

function getAgentSecret() {
  return AGENT_SECRET;
}

/** @type {import("child_process").ChildProcess | null} */
let agentProcess = null;

// Two spawn paths running at once would kill each other's fresh child.
let _spawning = false;
/** @type {NodeJS.Timeout | null} */
let _respawnTimer = null;
let _crashCount = 0;

// Set when the binary is missing or the OS refuses to run it (AV, permissions).
/** @type {{ code: string } | null} */
let _blocked = null;
const BLOCKING_SPAWN_ERRORS = new Set(["ENOENT", "EACCES", "EPERM"]);

// Newline-delimited JSON over stdin/stdout, matched back by request id.
let _cmdId = 0;
const _pending = new Map(); // id → { resolve, timer }
let _stdoutBuf = "";

// whenAgentReady() is the single owner of "is the agent up?".
let _isReady = false;
let _readyPromise = null;
let _readyResolve = null;
let _readyWait = null;
let _spawnedAt = 0;

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _resetReadiness() {
  _isReady = false;
  _readyPromise = new Promise((resolve) => {
    _readyResolve = resolve;
  });
}
_resetReadiness();

function _markReady(via) {
  if (_isReady) {
    return;
  }
  _isReady = true;
  logger.info(`[agent] ready (via ${via})`);
  _readyResolve?.();
}

/** Fails every in-flight pipe command rather than letting callers wait out their timeout. */
function _flushPending() {
  for (const [, entry] of _pending) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  _pending.clear();
  _stdoutBuf = "";
}

/** @returns {string} */
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
    if (!line) {
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    // The startup event carries no id.
    if (msg.event === "ready") {
      const sha = String(msg.source_sha || "unknown");
      if (!agentSourceMatches(msg.source_sha)) {
        logger.error(
          `[agent] source_sha ${sha.slice(0, 12)} does not match the ${String(
            expectedAgentSource()
          ).slice(0, 12)} this build shipped with — preflight will not pass`
        );
      }
      _markReady(
        `event agent_version=${msg.agent_version} source_sha=${sha.slice(0, 12)} pid=${msg.pid}`
      );
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

/**
 * Kills any stale agent left bound to the agent port by a previous crash.
 * Uses `netstat`+`taskkill` on Windows, `lsof`+`kill` on macOS/Linux.
 * @returns {Promise<void>}
 */
function killStaleAgent() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Safe by name: ours hasn't been spawned yet.
      const killByName = spawn("taskkill", ["/IM", "agent.exe", "/F"], { shell: false });
      killByName.on("close", (code) => {
        // Non-zero means nothing was running, so the slow port sweep can be skipped.
        if (code !== 0) {
          return resolve();
        }
        logger.info("[agent] stale agent.exe killed — sweeping port as well");
        const psCmd = `
          $lines = netstat -aon | Select-String ':${AGENT_PORT}.*LISTENING';
          foreach ($line in $lines) {
            $pid = ($line -split '\\s+')[-1];
            if ($pid -and $pid -ne '0') {
              taskkill /PID $pid /F 2>$null;
            }
          }
        `;
        const killByPort = spawn(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", psCmd],
          { shell: false }
        );
        killByPort.on("close", () => setTimeout(resolve, 500));
        killByPort.on("error", () => resolve());
      });
      killByName.on("error", () => resolve());
    } else {
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
        if (pids.length === 0) {
          return resolve();
        }

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

/**
 * Crash-loop backoff for the auto-respawn: 2s, 4s, 8s … capped at 30s, reset
 * once an agent has stayed up for a minute.
 * @param {number} uptimeMs - how long the agent that just exited had been running
 * @returns {number}
 */
function nextRespawnDelay(uptimeMs) {
  if (uptimeMs >= AGENT_STABLE_UPTIME_MS) {
    _crashCount = 0;
  }
  const delay = Math.min(AGENT_RESPAWN_BASE_MS * 2 ** _crashCount, AGENT_RESPAWN_MAX_MS);
  _crashCount += 1;
  return delay;
}

function _markBlocked(err) {
  _blocked = { code: err.code || "ENOENT" };
  logger.error(`[agent] cannot be started (${_blocked.code}): ${err.message}`);
}

/** Spawns the agent, first clearing whatever instance it replaces. */
async function spawnAgent() {
  if (_spawning) {
    logger.warn("[agent] spawn already in progress — skipping duplicate");
    return;
  }
  _spawning = true;
  _resetReadiness();
  if (_respawnTimer) {
    clearTimeout(_respawnTimer);
    _respawnTimer = null;
  }

  try {
    if (agentProcess) {
      // Only the tracked child: killing by name could take a sibling spawn.
      killAgent();
      // Let the old process release the port before the new one binds it.
      await new Promise((r) => setTimeout(r, 500));
    } else {
      await killStaleAgent();
    }

    const { command, args } = getAgentSpawn();
    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      _markBlocked(Object.assign(new Error(`${command} not found`), { code: "ENOENT" }));
      return;
    }
    try {
      const child = spawn(command, args, {
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          AGENT_LOG_DIR: app.getPath("userData"),
          APP_VERSION: app.getVersion(),
          AGENT_SECRET: AGENT_SECRET,
        },
      });
      agentProcess = child;
      _spawnedAt = Date.now();

      child.stdout.on("data", (d) => _consumeStdout(d.toString()));
      child.stderr.on("data", (d) => logger.info("[agent]", d.toString().trim()));

      child.on("spawn", () => {
        _blocked = null;
      });

      child.on("error", (err) => {
        if (agentProcess !== child) {
          return;
        }
        agentProcess = null;
        _isReady = false;
        _flushPending();
        if (BLOCKING_SPAWN_ERRORS.has(err.code)) {
          _markBlocked(err);
        } else {
          logger.error("[agent] process error:", err.message);
        }
      });

      child.on("exit", (code) => {
        // A replaced child's exit must not touch the newer child's state.
        if (agentProcess === null || agentProcess === child) {
          _flushPending();
        }
        if (agentProcess !== child) {
          return;
        }
        logger.warn(`[agent] exited with code ${code}`);
        agentProcess = null;
        _isReady = false;

        if (code !== 0 && !appState.isQuitting()) {
          const delay = nextRespawnDelay(Date.now() - _spawnedAt);
          logger.info(`[agent] scheduling auto-respawn in ${delay / 1000}s`);
          _respawnTimer = setTimeout(() => {
            _respawnTimer = null;
            if (!appState.isQuitting()) {
              logger.info("[agent] respawning...");
              spawnAgent();
            }
          }, delay);
        }
      });

      logger.info("[agent] spawned:", command, args.join(" "));
    } catch (err) {
      if (BLOCKING_SPAWN_ERRORS.has(err.code)) {
        _markBlocked(err);
      } else {
        logger.error("[agent] failed to spawn:", err.message);
      }
    }
  } finally {
    _spawning = false;
  }
}

/**
 * Spawns an agent if none is tracked, then waits for its `ready` event or a
 * successful ping. The ping covers older binaries that never send the event.
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function _driveReadiness(timeoutMs) {
  if (!agentProcess && !_spawning) {
    await spawnAgent();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_isReady) {
      return true;
    }
    if (_blocked && !agentProcess && !_spawning) {
      return false;
    }
    const viaEvent = await Promise.race([
      _readyPromise.then(() => true),
      _sleep(AGENT_POLL_INTERVAL_MS).then(() => false),
    ]);
    if (viaEvent || _isReady) {
      return true;
    }
    const res = await sendAgentCommand("ping", AGENT_REQUEST_TIMEOUT_MS);
    if (res && res.alive) {
      _markReady("ping");
      return true;
    }
  }
  logger.warn(`[agent] not ready within ${timeoutMs}ms`);
  return false;
}

/**
 * For progress messages only; false means "not up yet", not "dead".
 * @returns {boolean}
 */
function isAgentReady() {
  return _isReady && !!agentProcess;
}

/**
 * Resolves true once the agent is up, false on timeout. Never kills; concurrent
 * callers share one spawn and one poll loop.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function whenAgentReady(timeoutMs = AGENT_READY_TIMEOUT_MS) {
  if (_isReady && agentProcess) {
    return true;
  }
  if (!_readyWait) {
    _readyWait = _driveReadiness(AGENT_READY_TIMEOUT_MS).finally(() => {
      _readyWait = null;
    });
  }
  // A tighter budget gives up on its own clock without cancelling the shared drive.
  let timer;
  const bounded = new Promise((resolve) => {
    timer = setTimeout(() => resolve(_isReady), timeoutMs);
  });
  return await Promise.race([_readyWait, bounded]).finally(() => clearTimeout(timer));
}

/** True while a freshly spawned agent may still be booting. */
function inStartupGrace(now = Date.now()) {
  return !!agentProcess && now - _spawnedAt < AGENT_READY_TIMEOUT_MS;
}

/**
 * Kills and respawns an agent that stopped answering. A process still inside
 * its startup window is left alone: a cold start is slow, not dead.
 * @returns {Promise<boolean>} whether a restart was started
 */
async function restartAgent() {
  if (_spawning || inStartupGrace()) {
    return false;
  }
  logger.warn("[agent] restarting unresponsive agent");
  await spawnAgent();
  return true;
}

/** @returns {boolean} true when the binary is missing or the OS refused to run it */
function isAgentBlocked() {
  return _blocked !== null;
}

/** Terminates the agent and cancels any pending auto-respawn. */
function killAgent() {
  if (_respawnTimer) {
    clearTimeout(_respawnTimer);
    _respawnTimer = null;
  }
  if (agentProcess) {
    try {
      agentProcess.kill();
      logger.info("[agent] terminated cleanly");
    } catch (err) {
      logger.warn("[agent] kill failed:", err.message);
    }
    agentProcess = null;
    _isReady = false;
    // The exit handler skips this once agentProcess is null.
    _flushPending();
  }
}

module.exports = {
  spawnAgent,
  whenAgentReady,
  isAgentReady,
  killAgent,
  getAgentPath,
  getAgentSecret,
  sendAgentCommand,
  restartAgent,
  isAgentBlocked,
  _internal: {
    nextRespawnDelay,
    inStartupGrace,
    resetBackoff: () => {
      _crashCount = 0;
    },
  },
};
