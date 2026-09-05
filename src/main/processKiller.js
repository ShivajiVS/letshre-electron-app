/**
 * Force-terminates blocked applications, PID-accurately. Only processes in
 * ALL_BLOCKED_APPS (src/shared/appList.js) may be killed — this whitelist is
 * what stops the IPC handler from being abused to kill arbitrary OS processes.
 *
 * Flow: a vendor service that would restart the app is stopped first (see
 * APP_SERVICES — this needs elevation, so it usually takes the elevated retry),
 * then companions (launchers/updaters that would relaunch the main exe) are
 * killed before the main exe itself; we then verify by re-scanning PIDs and
 * watch briefly for a relaunch, so the result outcome ("closed", "respawned",
 * etc, see KillResult) reflects what actually happened, not a guess. Killing
 * is PID-by-PID (children before parents) against an explicit exclusion set,
 * rather than `taskkill /T`, so an excluded PID can never be swept up.
 *
 * SAFETY INVARIANT: we never terminate our own process, its ancestors, its
 * descendants, or the bundled security agent. Enforced two ways —
 * isOwnProcess() rejects by name, computeExclusionPids() builds the protected
 * PID set from the same snapshot the targets are chosen from. If the process
 * table can't be read, the kill fails rather than running with an unknown
 * exclusion set.
 */

"use strict";

const { spawn } = require("child_process");
const logger = require("./logger");
const { ALL_BLOCKED_APPS, getServices, isKnownService } = require("../shared/appList");
const {
  baseName,
  parseCsvLine,
  parseCreated,
  parseWindowsProcessCsv,
  parseUnixProcessTable,
  matchesImageName,
} = require("./processTable");
const {
  KILL_ENUM_TIMEOUT_MS,
  KILL_VERIFY_TIMEOUT_MS,
  KILL_VERIFY_POLL_MS,
  KILL_RELAUNCH_WATCH_MS,
  KILL_RELAUNCH_POLL_MS,
  KILL_ELEVATE_TIMEOUT_MS,
} = require("../shared/constants");

/**
 * @typedef {object} KillResult
 * @property {string} processName
 * @property {boolean} success
 * @property {"closed"|"already-gone"|"access-denied"|"respawned"|"still-running"
 *           |"not-blocked"|"own-process"|"spawn-error"|"unsupported"} outcome
 * @property {string} [error]              - technical detail for diagnostics, not UI
 * @property {string[]} [companionsKilled] - companion image names actually terminated
 * @property {string[]} [servicesStopped]  - vendor services stopped to stop a relaunch
 * @property {boolean} [serviceBacked]     - a service can restart this app; elevation may help
 * @property {number} [pidsKilled]
 */

/**
 * @typedef {object} ProcEntry
 * @property {number} pid
 * @property {number|null} ppid
 * @property {string} name     - image name (Windows) or executable basename (macOS)
 * @property {string} [command]- full command path, macOS only
 * @property {number} [created]- creation timestamp, monotonic-ish; NaN when unknown
 */

/** Outcomes that count as "the app is no longer running". */
const SUCCESS_OUTCOMES = ["closed", "already-gone"];

/**
 * Time budget for one killSingleProcess() call: enumeration + kill spawns +
 * verification poll + relaunch watch ≈ 12s worst case, ~1-2s in the common
 * case. killAllProcesses() runs every app concurrently, so N apps cost the
 * same as one.
 */
const DEFAULT_TIMING = {
  enumTimeoutMs: KILL_ENUM_TIMEOUT_MS,
  verifyTimeoutMs: KILL_VERIFY_TIMEOUT_MS,
  verifyPollMs: KILL_VERIFY_POLL_MS,
  relaunchWatchMs: KILL_RELAUNCH_WATCH_MS,
  relaunchPollMs: KILL_RELAUNCH_POLL_MS,
  elevateTimeoutMs: KILL_ELEVATE_TIMEOUT_MS,
};

// ─── Self-Protection Guard (by name)

/**
 * True if processName is our own Electron app — covers electron-builder's
 * version-suffixed names ("LetsHyre Secure Interview 1.0.0.exe"), the macOS
 * bundle/npm name, and dev-mode "electron.exe"/agent.exe.
 * @param {string} processName
 * @returns {boolean}
 */
function isOwnProcess(processName) {
  const name = String(processName || "").toLowerCase();

  const OWN_PREFIXES = [
    "letshyre secure interview", // with or without version suffix
    "letshyre-secure-interview", // npm/bundle name variant
  ];

  const OWN_EXACT = ["electron.exe", "electron", "agent.exe", "agent"];

  if (OWN_EXACT.includes(name)) {
    return true;
  }
  return OWN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Case-insensitive de-duplication that keeps first-seen order. */
function uniqueLower(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = String(v || "").toLowerCase();
    if (!k || seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(k);
  }
  return out;
}

function sleepReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawns a helper command (never a blocked app) and collects its output.
 * shell:false — args pass through directly, no shell parsing, so a crafted
 * process name can't inject a command.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: string}>}
 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch (err) {
      return resolve({ code: null, stdout: "", stderr: "", error: err.message });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: null, stdout, stderr, error: "timed out" });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    }
    child.on("error", (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

// ─── Exclusion set (the safety invariant) ────────────────────────────────────

/**
 * A parent link is trusted only when the parent isn't newer than the child.
 * PIDs get recycled, so without this a blocked app that inherited our
 * long-dead launcher's old PID would be mistaken for our ancestor and spared
 * forever. Trusted by default when creation times are unavailable.
 */
function isPlausibleParent(parent, child) {
  if (!parent || !child) {
    return false;
  }
  if (!Number.isFinite(parent.created) || !Number.isFinite(child.created)) {
    return true;
  }
  return parent.created <= child.created;
}

/**
 * Builds the set of PIDs we refuse to terminate, from one process-table
 * snapshot: our own PID and its ancestor chain, every descendant of our PID,
 * every process matching isOwnProcess() by name (a detached agent.exe isn't
 * in our tree but must still be protected) plus their descendants, and the
 * OS pseudo/root PIDs.
 *
 * Descendants are expanded ONLY from our own process and the own-named ones —
 * never from ancestors or OS roots, because launchd (PID 1) / explorer.exe
 * are ancestors of every user app and expanding them would protect the very
 * apps we're asked to close.
 *
 * @param {ProcEntry[]} procs
 * @param {number} selfPid
 * @param {NodeJS.Platform|string} platform
 * @returns {Set<number>}
 */
function computeExclusionPids(procs, selfPid, platform) {
  const list = Array.isArray(procs) ? procs : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of list) {
    if (!Number.isInteger(p.ppid)) {
      continue;
    }
    if (!children.has(p.ppid)) {
      children.set(p.ppid, []);
    }
    children.get(p.ppid).push(p);
  }

  const excluded = new Set([0]);
  excluded.add(platform === "darwin" ? 1 : 4); // launchd / Windows "System"

  const seeds = new Set();
  if (Number.isInteger(selfPid)) {
    seeds.add(selfPid);
  }
  for (const p of list) {
    if (isOwnProcess(p.name)) {
      seeds.add(p.pid);
    }
  }
  for (const pid of seeds) {
    excluded.add(pid);
  }

  // Ancestors of ourselves (individual PIDs only, not their subtrees).
  let cursor = byPid.get(selfPid);
  let hops = 0;
  while (cursor && hops++ < 64) {
    const parent = Number.isInteger(cursor.ppid) ? byPid.get(cursor.ppid) : null;
    if (!parent || !isPlausibleParent(parent, cursor)) {
      break;
    }
    if (excluded.has(parent.pid) && parent.pid !== selfPid) {
      break;
    } // cycle / already covered
    excluded.add(parent.pid);
    cursor = parent;
  }

  // Descendants of ourselves and of any own-named process.
  const queue = [...seeds];
  let guard = 0;
  while (queue.length && guard++ < 100000) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      if (excluded.has(child.pid)) {
        continue;
      }
      if (!isPlausibleParent(byPid.get(pid), child)) {
        continue;
      }
      excluded.add(child.pid);
      queue.push(child.pid);
    }
  }

  return excluded;
}

// ─── Kill ordering ───────────────────────────────────────────────────────────

/** Depth of a PID in the process tree (cycle-guarded). Deeper = more ancestors. */
function processDepth(proc, byPid) {
  let depth = 0;
  let cursor = proc;
  const seen = new Set();
  while (cursor && depth < 64) {
    if (seen.has(cursor.pid)) {
      break;
    }
    seen.add(cursor.pid);
    const parent = Number.isInteger(cursor.ppid) ? byPid.get(cursor.ppid) : null;
    if (!parent) {
      break;
    }
    depth++;
    cursor = parent;
  }
  return depth;
}

/**
 * Groups target PIDs into kill levels, deepest first, so a parent is never
 * terminated before its children. PIDs within one level are killed in parallel.
 * @param {ProcEntry[]} targets
 * @param {Map<number, ProcEntry>} byPid
 * @returns {number[][]}
 */
function planKillLevels(targets, byPid) {
  const levels = new Map();
  for (const proc of targets) {
    const depth = processDepth(proc, byPid);
    if (!levels.has(depth)) {
      levels.set(depth, []);
    }
    levels.get(depth).push(proc.pid);
  }
  return [...levels.keys()].sort((a, b) => b - a).map((d) => levels.get(d).sort((a, b) => a - b));
}

/**
 * Ordered list of image names to terminate: companions first (they relaunch
 * the main executable), main executable last. Companions come from our own
 * static table, not the renderer, so they needn't be on the blocklist — an
 * updater like "zoomupdater.exe" is never a blocked app but must still die.
 * Still filtered through isOwnProcess().
 * @param {string} processName
 * @param {(name: string) => string[]} getCompanions
 * @returns {string[]}
 */
function planTargetNames(processName, getCompanions) {
  const main = String(processName || "").toLowerCase();
  let companions = [];
  try {
    const raw = getCompanions(main);
    if (Array.isArray(raw)) {
      companions = raw;
    }
  } catch (err) {
    logger.warn("[processKiller] getCompanions threw:", err.message);
  }
  const cleaned = uniqueLower(companions).filter((c) => c !== main && !isOwnProcess(c));
  return [...cleaned, main];
}

/**
 * Whitelist rule for ONE kill candidate: killable if blocklisted, OR listed
 * as a companion of the target CURRENTLY being killed. Companions are
 * deliberately not on ALL_BLOCKED_APPS (a stray helper alone shouldn't fail
 * a detection scan), so the rule is scoped to that one target rather than a
 * union of every companion — otherwise the IPC surface could kill an
 * arbitrary helper by naming an unrelated app. isOwnProcess() and the
 * PID-level exclusion set still apply to every candidate, companions included.
 *
 * @param {string} candidate  - image name we are about to terminate
 * @param {string} targetName - the blocked app the user asked to close
 * @param {(name: string) => boolean} isBlocked
 * @param {(name: string) => string[]} getCompanions
 * @returns {boolean}
 */
function isKillableName(candidate, targetName, isBlocked, getCompanions) {
  const name = String(candidate || "").toLowerCase();
  if (!name || isOwnProcess(name)) {
    return false;
  }
  if (isBlocked(name)) {
    return true;
  }
  try {
    const raw = getCompanions(String(targetName || "").toLowerCase());
    return Array.isArray(raw) && raw.some((c) => String(c || "").toLowerCase() === name);
  } catch {
    return false;
  }
}

/**
 * Reads companions from appList lazily and defensively — missing export = no
 * companions.
 * @param {string} processName
 * @returns {string[]}
 */
function getCompanionsSafe(processName) {
  try {
    const appList = require("../shared/appList");
    if (typeof appList.getCompanions !== "function") {
      return [];
    }
    const result = appList.getCompanions(processName);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

/**
 * Required install-path fragment for a companion, or null on any failure —
 * safe, because null combined with requiresPathScopeSafe() makes the engine
 * drop the candidate rather than kill it unscoped.
 * @param {string} processName
 * @param {string} companionName
 * @returns {string|null}
 */
function getCompanionScopeSafe(processName, companionName) {
  try {
    const appList = require("../shared/appList");
    if (typeof appList.getCompanionScope !== "function") {
      return null;
    }
    return appList.getCompanionScope(processName, companionName) || null;
  } catch {
    return null;
  }
}

/**
 * True if this image name is shared across vendors and may only be killed
 * inside a path scope. An unknown name defaults to false (ordinary
 * vendor-exclusive companion), but a throw while checking returns true —
 * fail closed.
 * @param {string} companionName
 * @returns {boolean}
 */
function requiresPathScopeSafe(companionName) {
  try {
    const appList = require("../shared/appList");
    if (typeof appList.requiresPathScope !== "function") {
      return false;
    }
    return appList.requiresPathScope(companionName) === true;
  } catch {
    return true; // cannot verify the rule → refuse the kill
  }
}

// ─── Outcome classification (pure, unit-tested) ──────────────────────────────

/**
 * Maps a single taskkill/kill invocation onto a coarse status.
 *   killed — the OS confirmed termination (exit 0)
 *   gone   — the PID had already exited (taskkill 128 / "No such process")
 *   denied — insufficient privilege (elevated or protected process)
 *   error  — the helper could not be run, or an unrecognised failure
 * @param {{code: number|null, stderr?: string, stdout?: string, error?: string}} r
 * @returns {{status: "killed"|"gone"|"denied"|"error", detail?: string}}
 */
function classifyPidKill(r) {
  if (!r) {
    return { status: "error", detail: "no result" };
  }
  if (r.error) {
    return { status: "error", detail: r.error };
  }

  const text = `${r.stderr || ""} ${r.stdout || ""}`.toLowerCase();
  if (r.code === 0) {
    return { status: "killed" };
  }
  if (r.code === 128) {
    return { status: "gone" };
  }
  if (/not found|no such process|no running instance|not running/.test(text)) {
    return { status: "gone" };
  }
  if (/access is denied|operation not permitted|not permitted|insufficient/.test(text)) {
    return { status: "denied", detail: (r.stderr || "").trim() || "access denied" };
  }
  return { status: "error", detail: (r.stderr || "").trim() || `exit code ${r.code}` };
}

/**
 * Derives the reported outcome from measured signals only.
 * @param {object} signals
 * @param {number} signals.found       - matching PIDs seen before killing (incl. protected)
 * @param {number} signals.killable    - matching PIDs not in the exclusion set
 * @param {number} signals.killed      - PIDs the OS confirmed terminated
 * @param {number} signals.denied      - PIDs refused for privilege reasons
 * @param {number} signals.spawnErrors - kill invocations that could not run
 * @param {boolean} signals.cleared    - verification saw zero matching PIDs
 * @param {boolean} signals.respawned  - a matching PID reappeared after clearing
 * @returns {KillResult["outcome"]}
 */
function classifyKillOutcome(signals) {
  const {
    found = 0,
    killable = 0,
    killed = 0,
    denied = 0,
    spawnErrors = 0,
    cleared = false,
    respawned = false,
  } = signals || {};

  if (found === 0) {
    return "already-gone";
  }
  if (killable === 0) {
    return "still-running";
  } // every match is inside our own tree
  if (respawned) {
    return "respawned";
  }
  if (cleared) {
    return "closed";
  }
  if (denied > 0) {
    return "access-denied";
  }
  if (killed === 0 && spawnErrors > 0) {
    return "spawn-error";
  }
  return "still-running";
}

// ─── Platform probes (the only code that touches the OS) ─────────────────────

/**
 * Full process table with parent PIDs. Uses PowerShell + Get-CimInstance
 * rather than `wmic` (deprecated, absent on Windows 11 24H2 / Server 2025)
 * or `tasklist` (no parent PID, can't support the ancestor exclusion set or
 * children-first ordering). wmic is still tried as a fallback for locked-down
 * machines where PowerShell is blocked; if both fail we report failure rather
 * than killing with an unknown exclusion set.
 * @returns {Promise<{ok: boolean, procs: ProcEntry[], error?: string}>}
 */
async function listProcessTableReal(platform, timeoutMs) {
  if (platform === "darwin") {
    const r = await runCommand("ps", ["-Ao", "pid=,ppid=,comm="], timeoutMs);
    const procs = parseUnixProcessTable(r.stdout);
    if (procs.length) {
      return { ok: true, procs };
    }
    return {
      ok: false,
      procs: [],
      error: r.error || (r.stderr || "").trim() || "ps returned no rows",
    };
  }

  const psArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    // ExecutablePath is needed for path-scoped companions (the shared Squirrel
    // update.exe), and costs nothing extra on a query we already run.
    "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath," +
      "@{n='Created';e={$_.CreationDate.Ticks}} | ConvertTo-Csv -NoTypeInformation",
  ];
  const ps = await runCommand("powershell.exe", psArgs, timeoutMs);
  let procs = parseWindowsProcessCsv(ps.stdout);
  if (procs.length) {
    return { ok: true, procs };
  }

  logger.warn("[processKiller] Get-CimInstance enumeration failed, trying wmic fallback");
  const wmic = await runCommand(
    "wmic",
    ["process", "get", "Name,ParentProcessId,ProcessId,CreationDate", "/FORMAT:CSV"],
    timeoutMs
  );
  procs = parseWindowsProcessCsv(wmic.stdout);
  if (procs.length) {
    return { ok: true, procs };
  }

  const detail = ps.error || (ps.stderr || "").trim() || wmic.error || "no rows returned";
  return { ok: false, procs: [], error: `process enumeration failed: ${detail}` };
}

/**
 * Cheap presence probe for verification/relaunch-watch polling — avoids
 * re-running the slower full PowerShell enumeration on every poll.
 * @returns {Promise<{ok: boolean, pids: number[], error?: string}>}
 */
async function findPidsByNameReal(name, platform, timeoutMs) {
  if (platform === "darwin") {
    const r = await runCommand("ps", ["-Ao", "pid=,ppid=,comm="], timeoutMs);
    const procs = parseUnixProcessTable(r.stdout);
    if (!procs.length) {
      return { ok: false, pids: [], error: r.error || "ps returned no rows" };
    }
    return {
      ok: true,
      pids: procs.filter((p) => matchesImageName(p, name, platform)).map((p) => p.pid),
    };
  }

  const r = await runCommand(
    "tasklist",
    ["/FI", `IMAGENAME eq ${name}`, "/NH", "/FO", "CSV"],
    timeoutMs
  );
  if (r.error) {
    return { ok: false, pids: [], error: r.error };
  }

  const pids = [];
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("INFO:")) {
      continue;
    }
    const fields = parseCsvLine(trimmed);
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) {
      continue;
    }
    if (baseName(fields[0] || "").toLowerCase() !== String(name).toLowerCase()) {
      continue;
    }
    pids.push(pid);
  }
  return { ok: true, pids };
}

/**
 * Terminates ONE PID. `/T` is deliberately not used — we walk the tree
 * ourselves so that excluded PIDs can never be swept up by the OS.
 * @returns {Promise<{status: "killed"|"gone"|"denied"|"error", detail?: string}>}
 */
async function killPidReal(pid, platform, timeoutMs) {
  const r =
    platform === "darwin"
      ? await runCommand("kill", ["-9", String(pid)], timeoutMs)
      : await runCommand("taskkill", ["/PID", String(pid), "/F"], timeoutMs);
  return classifyPidKill(r);
}

/**
 * Stops a vendor service that would otherwise restart a blocked app.
 * Refuses anything not registered in APP_SERVICES — the guard lives here, next
 * to the command, rather than in the caller.
 *
 * @param {string} serviceName
 * @param {NodeJS.Platform|string} platform
 * @param {number} timeoutMs
 * @returns {Promise<{status: "stopped"|"absent"|"denied"|"refused"|"unsupported"|"error", detail?: string}>}
 */
async function stopServiceReal(serviceName, platform, timeoutMs) {
  if (platform !== "win32") {
    return { status: "unsupported" };
  }
  if (!isKnownService(serviceName)) {
    logger.warn("[processKiller] refusing to stop unregistered service:", serviceName);
    return { status: "refused", detail: "service not in APP_SERVICES" };
  }

  const r = await runCommand("sc.exe", ["stop", serviceName], timeoutMs);
  const text = `${r.stdout || ""} ${r.stderr || ""}`.toLowerCase();

  if (r.code === 0) {
    return { status: "stopped" };
  }
  if (/does not exist|not installed|has not been started/.test(text)) {
    return { status: "absent" };
  }
  if (/access is denied/.test(text)) {
    return { status: "denied", detail: "access denied" };
  }
  return { status: "error", detail: (r.stderr || "").trim() || `exit ${r.code}` };
}

// ─── Phase 5: elevation ──────────────────────────────────────────────────────

/**
 * Whether the CURRENT USER could satisfy an elevation prompt — deliberately
 * "is the user an administrator", not "are we already elevated". A non-admin
 * would get a UAC prompt demanding credentials they don't have (reads as the
 * app being broken), so we only offer the elevated retry to users who can
 * actually complete it. Cached: group membership can't change mid-session.
 *
 * @param {object} [deps]
 * @returns {Promise<boolean>}
 */
let _canElevateCache = null;
async function canElevate(deps = null) {
  const d = deps || createDefaultDeps();
  if (_canElevateCache !== null && !deps) {
    return _canElevateCache;
  }

  let result = false;
  try {
    if (d.platform === "win32") {
      // S-1-5-32-544 = BUILTIN\Administrators; SID match works on non-English Windows too.
      const r = await d.runProbe("whoami", ["/groups"], d.timing.enumTimeoutMs);
      result = /S-1-5-32-544/i.test(r.stdout || "");
    } else if (d.platform === "darwin") {
      const r = await d.runProbe("id", ["-Gn"], d.timing.enumTimeoutMs);
      result = /\badmin\b/.test(r.stdout || "");
    }
  } catch (err) {
    logger.warn("[processKiller] canElevate probe failed:", err.message);
    result = false; // cannot prove they can elevate → do not offer it
  }

  if (!deps) {
    _canElevateCache = result;
  }
  return result;
}

/**
 * Terminates a set of PIDs through ONE elevation prompt — never one per PID,
 * since a candidate faced with six UAC dialogs will just cancel, and a
 * per-PID prompt lets the app's relauncher win the race between dialogs.
 *
 * @param {number[]} pids
 * @param {object} deps
 * @returns {Promise<{status: string, detail?: string}>}
 */
async function killPidsElevatedReal(pids, deps, services = []) {
  // Injection guard: these reach a shell-interpreted command string, so accept
  // nothing but positive integers. They come from our own enumeration, but the
  // validation is what makes that guarantee local and auditable.
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (safe.length === 0) {
    return { status: "error", detail: "no valid PIDs" };
  }
  if (safe.length !== pids.length) {
    return { status: "error", detail: "refusing to elevate with a malformed PID list" };
  }

  // Same rule for services: only names registered in APP_SERVICES reach a
  // command line, and one bad name voids the whole batch rather than being
  // quietly dropped.
  const safeServices = (services || []).filter((name) => isKnownService(name));
  if (safeServices.length !== (services || []).length) {
    return { status: "error", detail: "refusing to elevate with an unregistered service" };
  }

  if (deps.platform === "win32") {
    // With services in play the elevated child has to run more than one command,
    // so it becomes a cmd.exe chain. Still ONE prompt — the reason the whole
    // batch goes up together in the first place.
    const command =
      safeServices.length > 0
        ? `Start-Process -FilePath cmd.exe -ArgumentList '/c','${[
            ...safeServices.map((name) => `sc stop ${name}`),
            `taskkill /F ${safe.map((p) => `/PID ${p}`).join(" ")}`,
          ].join(" & ")}' -Verb RunAs -Wait -WindowStyle Hidden`
        : `Start-Process -FilePath taskkill.exe -ArgumentList ${[
            "'/F'",
            ...safe.flatMap((p) => ["'/PID'", `'${p}'`]),
          ].join(",")} -Verb RunAs -Wait -WindowStyle Hidden`;

    const r = await deps.runProbe(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      deps.timing.elevateTimeoutMs
    );
    const text = `${r.stdout || ""} ${r.stderr || ""}`;
    // The user declining UAC surfaces as a "canceled by the user" error.
    if (/cancel/i.test(text)) {
      return { status: "cancelled", detail: "elevation declined" };
    }
    if (r.code === 0) {
      return { status: "killed" };
    }
    return { status: "error", detail: (r.stderr || "").trim() || `exit ${r.code}` };
  }

  if (deps.platform === "darwin") {
    const r = await deps.runProbe(
      "osascript",
      ["-e", `do shell script "kill -9 ${safe.join(" ")}" with administrator privileges`],
      deps.timing.elevateTimeoutMs
    );
    const text = `${r.stdout || ""} ${r.stderr || ""}`;
    if (/User canceled|-128/i.test(text)) {
      return { status: "cancelled", detail: "elevation declined" };
    }
    if (r.code === 0) {
      return { status: "killed" };
    }
    return { status: "error", detail: (r.stderr || "").trim() || `exit ${r.code}` };
  }

  return { status: "error", detail: `elevation unsupported on ${deps.platform}` };
}

/** Builds the default (real-OS) dependency set. Tests inject fakes instead. */
function createDefaultDeps() {
  const platform = process.platform;
  const timing = DEFAULT_TIMING;
  return {
    platform,
    selfPid: process.pid,
    timing,
    isBlocked: (name) => ALL_BLOCKED_APPS.includes(name),
    getCompanions: getCompanionsSafe,
    getCompanionScope: getCompanionScopeSafe,
    requiresPathScope: requiresPathScopeSafe,
    listProcessTable: () => listProcessTableReal(platform, timing.enumTimeoutMs),
    findPidsByName: (name) => findPidsByNameReal(name, platform, timing.enumTimeoutMs),
    killPid: (pid) => killPidReal(pid, platform, timing.enumTimeoutMs),
    sleep: sleepReal,
    runProbe: runCommand,
    killPidsElevated: (pids, deps, services) => killPidsElevatedReal(pids, deps, services),
    getServices,
    stopService: (name) => stopServiceReal(name, platform, timing.elevateTimeoutMs),
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Force-terminates a single blocked application, PID-accurately.
 *
 * @param {string} processName - image name, must be on ALL_BLOCKED_APPS
 * @param {object} [overrides] - dependency injection seam for tests ONLY;
 *                               production callers pass one argument.
 * @returns {Promise<KillResult>}
 */
async function killSingleProcess(processName, overrides) {
  const deps = { ...createDefaultDeps(), ...(overrides || {}) };
  const timing = { ...DEFAULT_TIMING, ...(deps.timing || {}) };
  const name = String(processName || "").toLowerCase();

  /** @returns {KillResult} */
  const finish = (partial) => ({
    processName,
    success: SUCCESS_OUTCOMES.includes(partial.outcome),
    ...partial,
  });

  // Guard 1: never kill ourselves (by name)
  if (isOwnProcess(name)) {
    logger.warn("[processKiller] blocked attempt to kill own process:", processName);
    return finish({ outcome: "own-process", error: "Cannot kill own process" });
  }

  // Guard 2: whitelist
  if (!deps.isBlocked(name)) {
    logger.warn("[processKiller] rejected attempt to kill non-blocked process:", processName);
    return finish({ outcome: "not-blocked", error: "Process not in blocked list" });
  }

  if (deps.platform !== "win32" && deps.platform !== "darwin") {
    return finish({ outcome: "unsupported", error: `Unsupported platform: ${deps.platform}` });
  }

  // Snapshot the process table
  const snapshot = await deps.listProcessTable();
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.procs) || snapshot.procs.length === 0) {
    // Fail closed: without a table we can't compute the exclusion set, and
    // killing with an unknown exclusion set could take down our own app.
    const detail = (snapshot && snapshot.error) || "process table unavailable";
    logger.error("[processKiller] refusing to kill — ", detail);
    return finish({ outcome: "spawn-error", error: detail });
  }

  const procs = snapshot.procs;
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // Guard 3: never kill ourselves (by PID)
  const excluded = computeExclusionPids(procs, deps.selfPid, deps.platform);

  // Companions first, main executable last; every candidate is re-checked
  // against the scoped whitelist rule before it can be touched.
  const targetNames = planTargetNames(name, deps.getCompanions).filter((candidate) =>
    isKillableName(candidate, name, deps.isBlocked, deps.getCompanions)
  );

  let found = 0;
  let protectedMatches = 0;
  const groups = targetNames.map((targetName) => {
    // A shared-name companion is only killable inside its owning app's
    // install directory. If it requires a scope but we have none for THIS
    // app, drop it entirely rather than kill by name — see
    // APP_COMPANION_SCOPES in shared/appList.js.
    const scope = deps.getCompanionScope(name, targetName);
    if (!scope && targetName !== name && deps.requiresPathScope(targetName)) {
      logger.warn(
        `[processKiller] refusing to kill shared companion "${targetName}" — no path scope for ${name}`
      );
      return { name: targetName, procs: [] };
    }
    const matches = procs.filter((p) => matchesImageName(p, targetName, deps.platform, scope));
    const killable = matches.filter((p) => !excluded.has(p.pid));
    found += matches.length;
    protectedMatches += matches.length - killable.length;
    return { name: targetName, procs: killable };
  });
  const killable = groups.reduce((sum, g) => sum + g.procs.length, 0);

  if (found === 0) {
    logger.info(`[processKiller] ${name} was already gone`);
    return finish({ outcome: "already-gone", pidsKilled: 0, companionsKilled: [] });
  }

  if (killable === 0) {
    logger.warn(
      `[processKiller] every ${name} PID is inside the protected process tree — refusing`
    );
    return finish({
      outcome: classifyKillOutcome({ found, killable: 0 }),
      error: "All matching processes belong to the protected (own) process tree",
      pidsKilled: 0,
      companionsKilled: [],
    });
  }

  // Kill children before parents, group by group
  let killed = 0;
  let denied = 0;
  let spawnErrors = 0;
  let lastError = "";
  const companionsKilled = [];

  // Services first: a running service restarts the app between the kill and the
  // verification poll, which is the whole reason these apps read as "respawned".
  const services = deps.platform === "win32" ? deps.getServices(name) : [];
  const servicesStopped = [];
  if (!deps.elevated) {
    for (const service of services) {
      const r = await deps.stopService(service);
      if (r.status === "stopped") {
        servicesStopped.push(service);
      } else if (r.status === "absent") {
        // The app is running but the service we registered for it is not
        // installed — usually means the name in APP_SERVICES is wrong.
        logger.warn(`[processKiller] ${name}: registered service ${service} is not installed`);
      } else if (r.status === "denied") {
        lastError = "stopping the background service needs administrator rights";
      }
    }
  }

  if (deps.elevated) {
    // ONE elevation prompt for every PID across every group — per-PID/per-group
    // prompting would make a candidate accept a dozen UAC dialogs and give the
    // relauncher a window to win between them. taskkill gets the whole set at once.
    const allPids = groups.flatMap((g) => planKillLevels(g.procs, byPid).flat());
    const r = await deps.killPidsElevated(allPids, { ...deps, timing }, services);
    if (r.status === "killed") {
      killed = allPids.length;
      servicesStopped.push(...services);
      for (const g of groups) {
        if (g.procs.length && g.name !== name) {
          companionsKilled.push(g.name);
        }
      }
    } else if (r.status === "cancelled") {
      // Declined prompt, not our failure — report as denied so the UI offers
      // the manual route instead of looping the prompt.
      denied = allPids.length;
      lastError = r.detail || "elevation declined";
    } else {
      spawnErrors = allPids.length;
      lastError = r.detail || "elevated kill failed";
    }
  } else {
    for (const group of groups) {
      if (!group.procs.length) {
        continue;
      }
      let groupKilled = 0;
      for (const level of planKillLevels(group.procs, byPid)) {
        const results = await Promise.all(level.map((pid) => deps.killPid(pid)));
        for (const r of results) {
          if (r.status === "killed") {
            killed++;
            groupKilled++;
          } else if (r.status === "denied") {
            denied++;
            lastError = r.detail || "access denied";
          } else if (r.status === "error") {
            spawnErrors++;
            lastError = r.detail || "kill failed";
          }
          // "gone" — the PID exited between snapshot and kill; not an error.
        }
      }
      if (groupKilled > 0 && group.name !== name) {
        companionsKilled.push(group.name);
      }
    }
  }

  // Verification: poll until no target PID remains, or the budget expires
  const anyTargetAlive = async () => {
    for (const targetName of targetNames) {
      const r = await deps.findPidsByName(targetName);
      if (!r || !r.ok) {
        return null;
      } // indeterminate — treat as "still there"
      if (r.pids.length > 0) {
        return true;
      }
    }
    return false;
  };

  let cleared = false;
  const verifyAttempts = Math.max(1, Math.ceil(timing.verifyTimeoutMs / timing.verifyPollMs));
  for (let i = 0; i < verifyAttempts; i++) {
    await deps.sleep(timing.verifyPollMs);
    const alive = await anyTargetAlive();
    if (alive === false) {
      cleared = true;
      break;
    }
    if (alive === null) {
      lastError = lastError || "could not verify — process query failed";
    }
  }

  // Relaunch watch — the actual reported bug
  let respawned = false;
  if (cleared) {
    const watchAttempts = Math.max(1, Math.ceil(timing.relaunchWatchMs / timing.relaunchPollMs));
    for (let i = 0; i < watchAttempts; i++) {
      await deps.sleep(timing.relaunchPollMs);
      const alive = await anyTargetAlive();
      if (alive === true) {
        respawned = true;
        break;
      }
    }
  }

  const outcome = classifyKillOutcome({
    found,
    killable,
    killed,
    denied,
    spawnErrors,
    cleared,
    respawned,
  });
  const result = finish({
    outcome,
    pidsKilled: killed,
    companionsKilled,
    ...(servicesStopped.length > 0 ? { servicesStopped } : {}),
    // Tells the UI an elevated retry is worth offering on a respawn — for
    // everything else the relauncher is user-level and elevation changes nothing.
    ...(services.length > 0 ? { serviceBacked: true } : {}),
    ...(outcome === "closed" || outcome === "already-gone"
      ? {}
      : { error: describeFailure(outcome, lastError, protectedMatches, services) }),
  });

  logger[result.success ? "info" : "warn"](
    `[processKiller] ${name} → ${outcome} (pids killed: ${killed}, companions: ${companionsKilled.join(", ") || "none"})`
  );
  return result;
}

/**
 * Technical diagnostic string for a failed kill. NOT user-facing copy — the
 * renderer keys its message off `outcome`.
 */
function describeFailure(outcome, lastError, protectedMatches, services = []) {
  switch (outcome) {
    case "respawned":
      return services.length > 0
        ? `Process reappeared after termination — the ${services.join(", ")} service ` +
            "restarts it, and stopping that needs administrator rights"
        : "Process reappeared after termination (relaunched by a background service)";
    case "access-denied":
      return lastError || "Access denied — process is elevated or protected";
    case "spawn-error":
      return lastError || "Termination command could not be executed";
    default:
      return (
        lastError ||
        (protectedMatches > 0
          ? "Process still running and is inside the protected process tree"
          : "Process still running after termination")
      );
  }
}

/**
 * Force-terminates all provided processes in parallel.
 * The returned array is index-aligned with `processNames`.
 * @param {string[]} processNames
 * @param {object} [overrides] - test seam, forwarded to killSingleProcess
 * @returns {Promise<KillResult[]>}
 */
async function killAllProcesses(processNames, overrides) {
  const names = Array.isArray(processNames) ? processNames : [];
  return await Promise.all(names.map((name) => killSingleProcess(name, overrides)));
}

/**
 * Retry a kill with elevated privileges, behind ONE consent prompt. A
 * separate entry point rather than an automatic fallback in killSingleProcess()
 * — elevation shows a system dialog, so it must only happen because the user
 * explicitly asked, never as a silent retry or in a loop. Caller offers it
 * only when canElevate() is true and outside an active interview. Every
 * guard from the normal path still applies (whitelist, self-protection,
 * PID exclusion, companion path scoping).
 *
 * @param {string} processName
 * @param {object} [overrides] - test injection seam
 * @returns {Promise<KillResult>}
 */
async function killSingleProcessElevated(processName, overrides) {
  return await killSingleProcess(processName, { ...(overrides || {}), elevated: true });
}

module.exports = {
  killSingleProcess,
  killAllProcesses,
  killSingleProcessElevated,
  canElevate,
  isOwnProcess,
  // Exported for unit tests — pure decision logic, no OS access.
  _internal: {
    parseCsvLine,
    parseCreated,
    parseWindowsProcessCsv,
    parseUnixProcessTable,
    matchesImageName,
    computeExclusionPids,
    planKillLevels,
    planTargetNames,
    isKillableName,
    getCompanionsSafe,
    getCompanionScopeSafe,
    requiresPathScopeSafe,
    killPidsElevatedReal,
    stopServiceReal,
    classifyPidKill,
    classifyKillOutcome,
    describeFailure,
    DEFAULT_TIMING,
  },
};
