/**
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
  AGENT_POLL_INTERVAL_MS,
  AGENT_READY_TIMEOUT_MS,
  AGENT_REQUEST_TIMEOUT_MS,
} = require("../shared/constants");

const crypto = require("crypto");
const AGENT_SECRET = crypto.randomBytes(16).toString("hex");

function getAgentSecret() {
  return AGENT_SECRET;
}

/** @type {import("child_process").ChildProcess | null} */
let agentProcess = null;

// Guards against two spawn paths (auto-respawn timer + ensureAgent) running
// concurrently and killing each other's freshly-spawned child by image name.
let _spawning = false;
/** @type {NodeJS.Timeout | null} */
let _respawnTimer = null;

//Pipe protocol state
// Electron talks to the agent over stdin/stdout using newline-delimited JSON.
// Each request carries an incrementing id; responses are matched back by id.
let _cmdId = 0;
const _pending = new Map(); // id → { resolve, timer }
let _stdoutBuf = ""; // accumulates partial stdout lines

// Readiness state — the SINGLE owner of "is the agent up?". Everything that used
// to poll on its own (pre-warm, ensureAgent, the preflight agent check) now goes
// through whenAgentReady() so no two pollers can disagree and kill a live agent.
let _isReady = false;
let _readyPromise = null; // resolves when the current child signals ready
let _readyResolve = null;
let _readyWait = null; // shared in-flight whenAgentReady() drive
let _spawnedAt = 0; // ms timestamp of the last spawn — the startup grace window

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Re-arms the readiness promise for a fresh child. Called at every spawn. */
function _resetReadiness() {
  _isReady = false;
  _readyPromise = new Promise((resolve) => {
    _readyResolve = resolve;
  });
}
_resetReadiness();

/** Marks the agent ready and wakes every waiter. Idempotent. */
function _markReady(via) {
  if (_isReady) {
    return;
  }
  _isReady = true;
  logger.info(`[agent] ready (via ${via})`);
  _readyResolve?.();
}

/** Fails every in-flight pipe command instead of letting callers hang until
 *  their own timeout. Runs on explicit kill as well as on process exit. */
function _flushPending() {
  for (const [, entry] of _pending) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  _pending.clear();
  _stdoutBuf = "";
}

/**
 * Resolves the absolute path to the agent binary (packaged vs. dev).
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
    if (!line) {
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not protocol JSON (shouldn't happen — logs go to stderr). Ignore.
      continue;
    }
    // Unsolicited startup event: {"event":"ready", ...} carries no `id`, so it
    // has to be handled before the response-matching lookup below.
    if (msg.event === "ready") {
      _markReady(`event agent_version=${msg.agent_version} pid=${msg.pid}`);
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

// Stale Agent Cleanup

/**
 * Kills any stale agent left bound to the agent port by a previous crash.
 * Uses `netstat`+`taskkill` on Windows, `lsof`+`kill` on macOS/Linux.
 * @returns {Promise<void>}
 */
function killStaleAgent() {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Step 1: Kill all agent.exe by image name (safe — we haven't spawned ours yet)
      const killByName = spawn("taskkill", ["/IM", "agent.exe", "/F"], { shell: false });
      killByName.on("close", (code) => {
        // taskkill exits non-zero (128) when no agent.exe existed. Nothing stale
        // to clear, so skip the cold PowerShell netstat sweep and the settle
        // wait — they cost 1.4-5.2s on every spawn, cold-start included.
        if (code !== 0) {
          return resolve();
        }
        logger.info("[agent] stale agent.exe killed — sweeping port as well");
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
 * Spawns the Python security agent binary and keeps a reference to it.
 * Kills any stale orphaned agent first, then spawns fresh.
 * Logs stdout/stderr and auto-respawns on unexpected exit.
 */
async function spawnAgent() {
  // Re-entrancy guard: never let two spawn paths run at once (they would
  // taskkill each other's child by image name and clobber agentProcess).
  if (_spawning) {
    logger.warn("[agent] spawn already in progress — skipping duplicate");
    return;
  }
  _spawning = true;
  // A new child means a new readiness question — nothing carries over.
  _resetReadiness();
  // A spawn supersedes any pending auto-respawn.
  if (_respawnTimer) {
    clearTimeout(_respawnTimer);
    _respawnTimer = null;
  }

  try {
    if (agentProcess) {
      // We already track a live agent — terminate ONLY it, never taskkill all
      // agent.exe by name (which would kill a concurrently-spawned sibling).
      killAgent();
      // Give the OS a moment to release port 9999 before the new agent binds it,
      // so a still-dying old process can't cause the fresh one to EADDRINUSE-exit
      // and churn the respawn loop. (killStaleAgent waits similarly below.)
      await new Promise((r) => setTimeout(r, 500));
    } else {
      // No tracked agent — clear a true orphan from a previous run (by port/name).
      await killStaleAgent();
    }

    const { command, args } = getAgentSpawn();
    try {
      // Phase 2: stdin is piped so we can send commands. stdout carries the JSON
      // protocol (parsed by _consumeStdout); stderr carries the agent's logs.
      const child = spawn(command, args, {
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        // IMP-08: agent writes its log to userData (writable in all modes).
        // IMP-12: pass the canonical app version so the agent needs no own string.
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
      // stderr is the agent's normal log channel now (logs moved off stdout).
      child.stderr.on("data", (d) => logger.info("[agent]", d.toString().trim()));

      child.on("exit", (code) => {
        // Flush unless a NEWER child already owns the pipe state — those pending
        // commands belong to it. On an explicit kill agentProcess is already
        // null, and killAgent() has flushed; this stays a no-op then.
        if (agentProcess === null || agentProcess === child) {
          _flushPending();
        }
        // Ignore exit events from a process we've already replaced — otherwise an
        // old child's exit would null the NEW agentProcess and trigger a stray
        // respawn (kill/respawn thrash).
        if (agentProcess !== child) {
          return;
        }
        logger.warn(`[agent] exited with code ${code}`);
        agentProcess = null;
        _isReady = false;

        // Auto-respawn on unexpected death (not during app shutdown). Tracked in
        // _respawnTimer so killAgent()/shutdown can cancel it (otherwise it could
        // fire after will-quit and orphan a fresh agent past app exit).
        if (code !== 0 && !appState.isQuitting()) {
          logger.info("[agent] scheduling auto-respawn in 2s...");
          _respawnTimer = setTimeout(() => {
            _respawnTimer = null;
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
  } finally {
    _spawning = false;
  }
}

/**
 * Drives the agent to readiness: spawns one if none is tracked, then waits for
 * either the startup `ready` event or a successful ping, whichever lands first.
 *
 * The ping poll is the backward-compatibility path: resources/agent.exe is
 * gitignored and may predate the ready event, so an old binary is only ever
 * observable by probing it.
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
    // Race the event against a poll tick, then probe once. A busy agent that
    // answers late is still ready — it is never treated as dead here.
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
 * Synchronous, non-committal read of the readiness flag — no spawn, no probe.
 * Only for deciding what to TELL the user while they wait (see the preflight's
 * "starting" card). Never gate anything on it: false here means "not up yet",
 * not "dead". whenAgentReady() is the answer that counts.
 * @returns {boolean}
 */
function isAgentReady() {
  return _isReady && !!agentProcess;
}

/**
 * The one way to ask "is the agent up?". Resolves true once the agent has
 * signalled ready (event) or answered a ping, false on timeout — never hangs,
 * never kills. Concurrent callers share a single drive, so there is exactly one
 * spawn and one poll loop no matter how many pages/scans ask at once.
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
  // Callers with a tighter budget than the shared drive give up on their own
  // clock without cancelling it for everyone else.
  let timer;
  const bounded = new Promise((resolve) => {
    timer = setTimeout(() => resolve(_isReady), timeoutMs);
  });
  return await Promise.race([_readyWait, bounded]).finally(() => clearTimeout(timer));
}

/**
 * Ensures the agent is alive, respawning it only if it genuinely failed. Called
 * before each preflight so a transient agent failure (crash, AV kill) is
 * recoverable by re-scanning rather than permanently blocking the candidate.
 * @returns {Promise<boolean>} true if the agent is alive (or came back).
 */
async function ensureAgent() {
  if (_isReady && agentProcess) {
    return true;
  }
  // A process spawned moments ago is STARTING, not dead: a cold PyInstaller
  // unpack easily outlasts any ping budget. Killing it here restarted the
  // cold-start clock and was the main cause of "agent failed to start".
  if (agentProcess && Date.now() - _spawnedAt < AGENT_READY_TIMEOUT_MS) {
    return await whenAgentReady();
  }
  if (await whenAgentReady()) {
    return true;
  }
  logger.warn("[agent] readiness timed out — respawning before preflight");
  await spawnAgent();
  return await whenAgentReady();
}

/**
 * Terminates the agent process if it is running.
 * Called during app `will-quit`.
 */
function killAgent() {
  // Cancel any pending auto-respawn so it can't fire after shutdown.
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
    // The child's exit event can't do this for us — agentProcess is already
    // null by then, so its guard short-circuits and pending commands would
    // hang for their full timeout.
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
  ensureAgent,
};
