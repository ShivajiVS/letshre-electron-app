/**
 * src/main/processKiller.js
 * ─────────────────────────
 * Force-terminates blocked applications, PID-accurately.
 *
 * Only processes in ALL_BLOCKED_APPS (from src/shared/appList.js) may be
 * killed — all others are rejected. This whitelist prevents the IPC handler
 * from being abused to kill arbitrary OS processes.
 *
 * Design (see the four phases below):
 *
 *  1. OUTCOME CLASSIFICATION — every kill returns a structured {@link KillResult}
 *     whose `outcome` is derived from real signals (per-PID exit codes plus a
 *     PID-level re-scan), never from a guess. `success` is true only for
 *     "closed" and "already-gone".
 *
 *  2. COMPANION-FIRST ORDERING — launcher/updater/tray processes that would
 *     relaunch the main executable are terminated BEFORE it, so nothing
 *     survives to respawn it. Companions come from appList.getCompanions();
 *     a missing export is treated as "no companions" so this module keeps
 *     working while that list is being written.
 *
 *  3. RELAUNCH DETECTION — after the target goes clear we keep watching for a
 *     few seconds. A process that comes back reports outcome "respawned"
 *     instead of a false "closed".
 *
 *  4. PID-ACCURATE TERMINATION — we enumerate the whole process table (PID +
 *     parent PID), select the PIDs belonging to the target image names, order
 *     them children-before-parents, and kill them individually. This gives the
 *     completeness of `taskkill /T` without its danger, because the target set
 *     is filtered through an explicit exclusion set first.
 *
 * SAFETY INVARIANT
 * ────────────────
 * We never terminate our own process, its ancestors, its descendants, or the
 * bundled security agent. Two independent guards enforce this:
 *   • by NAME — isOwnProcess() rejects the request outright, and
 *   • by PID  — computeExclusionPids() builds the protected PID set from the
 *               same process-table snapshot the targets are chosen from.
 * If the process table cannot be read, the kill FAILS rather than proceeding
 * with an unknown exclusion set.
 */

"use strict";

const { spawn } = require("child_process");
const logger = require("./logger");
const { ALL_BLOCKED_APPS } = require("../shared/appList");
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
 * Total time budget for one killSingleProcess() call:
 *   enumeration (≤ KILL_ENUM_TIMEOUT_MS, typically ~300ms)
 * + the kill spawns (batched in parallel per tree level)
 * + verification poll   (≤ KILL_VERIFY_TIMEOUT_MS)
 * + relaunch watch      (≤ KILL_RELAUNCH_WATCH_MS, only after the target went clear)
 * ≈ 12s absolute worst case, ~1–2s in the common "it just closed" path.
 * killAllProcesses() runs every app concurrently, so N apps cost the same as one.
 */
const DEFAULT_TIMING = {
  enumTimeoutMs: KILL_ENUM_TIMEOUT_MS,
  verifyTimeoutMs: KILL_VERIFY_TIMEOUT_MS,
  verifyPollMs: KILL_VERIFY_POLL_MS,
  relaunchWatchMs: KILL_RELAUNCH_WATCH_MS,
  relaunchPollMs: KILL_RELAUNCH_POLL_MS,
  elevateTimeoutMs: KILL_ELEVATE_TIMEOUT_MS,
};

// ─── Self-Protection Guard (by name) ─────────────────────────────────────────

/**
 * Returns true if the given process name matches our own Electron app.
 * Handles version-suffixed names (e.g. "LetsHyre Secure Interview 1.0.0.exe").
 *
 * Windows: electron-builder produces "LetsHyre Secure Interview.exe"
 *          and version-suffixed "LetsHyre Secure Interview 1.0.0.exe".
 * macOS:   "LetsHyre Secure Interview.app" or "letshyre-secure-interview".
 * Dev:     "electron.exe" / "electron".
 * @param {string} processName
 * @returns {boolean}
 */
function isOwnProcess(processName) {
  const name = String(processName || "").toLowerCase();

  // Prefix matches — covers version-suffixed names and .app/.exe extensions
  const OWN_PREFIXES = [
    "letshyre secure interview", // matches with or without version suffix
    "letshyre-secure-interview", // npm/bundle name variant
  ];

  // Exact matches for dev mode and agent process
  const OWN_EXACT = ["electron.exe", "electron", "agent.exe", "agent"];

  if (OWN_EXACT.includes(name)) {return true;}
  return OWN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Basename that understands both `/` and `\` regardless of host platform. */
function baseName(p) {
  const parts = String(p || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** Case-insensitive de-duplication that keeps first-seen order. */
function uniqueLower(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = String(v || "").toLowerCase();
    if (!k || seen.has(k)) {continue;}
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
 * Uses spawn() with shell:false — arguments are passed directly, no shell
 * parsing, so a crafted process name cannot inject a command.
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
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr, error: "timed out" });
    }, timeoutMs);

    if (child.stdout) {child.stdout.on("data", (d) => { stdout += d.toString(); });}
    if (child.stderr) {child.stderr.on("data", (d) => { stderr += d.toString(); });}
    child.on("error", (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

// ─── Process-table parsing (pure, unit-tested) ───────────────────────────────

/**
 * Splits one CSV line, honouring double quotes and "" escapes.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Parses a WMI creation timestamp into a comparable number.
 * Accepts PowerShell `.Ticks` (all digits) and the WMI datetime string
 * ("20260815181828.123456+330" → 20260815181828). Returns NaN when unknown.
 * @param {string} value
 * @returns {number}
 */
function parseCreated(value) {
  const raw = String(value || "").trim();
  if (!raw) {return NaN;}
  if (/^\d+$/.test(raw)) {return Number(raw);}
  const m = raw.match(/^(\d{14})/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Parses headered CSV process output (PowerShell Get-CimInstance or wmic).
 * Both emit a header row containing ProcessId/ParentProcessId/Name, so one
 * header-driven parser covers both. Rows without a usable PID are dropped;
 * blank lines, `#TYPE` preambles and short/missing fields are tolerated.
 * @param {string} text
 * @returns {ProcEntry[]}
 */
function parseWindowsProcessCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#TYPE"));

  let cols = null;
  const procs = [];

  for (const line of lines) {
    const fields = parseCsvLine(line);

    if (!cols) {
      const lower = fields.map((f) => f.replace(/^"|"$/g, "").toLowerCase());
      const pidIdx = lower.indexOf("processid");
      if (pidIdx === -1) {continue;} // still looking for the header row
      cols = {
        pid: pidIdx,
        ppid: lower.indexOf("parentprocessid"),
        name: lower.indexOf("name"),
        path: lower.indexOf("executablepath"),
        created: lower.findIndex((c) => c === "created" || c === "creationdate"),
      };
      continue;
    }

    const pid = Number(fields[cols.pid]);
    if (!Number.isInteger(pid) || pid < 0) {continue;}

    const ppidRaw = cols.ppid >= 0 ? Number(fields[cols.ppid]) : NaN;
    const created = cols.created >= 0 ? parseCreated(fields[cols.created]) : NaN;
    // Absent for protected/system processes and on the wmic fallback. Left as
    // "" rather than guessed — a path-scoped companion must FAIL to match when
    // the path is unknown, never fall back to an image-name-only match.
    const path = cols.path >= 0 ? String(fields[cols.path] || "").replace(/^"|"$/g, "") : "";

    procs.push({
      pid,
      ppid: Number.isInteger(ppidRaw) ? ppidRaw : null,
      name: baseName(fields[cols.name] || ""),
      path,
      created,
    });
  }

  return procs;
}

/**
 * Parses `ps -Ao pid=,ppid=,comm=` output. `comm` on macOS is the full
 * executable path and may contain spaces, so everything after the second
 * numeric column is the command.
 * @param {string} text
 * @returns {ProcEntry[]}
 */
function parseUnixProcessTable(text) {
  const procs = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!m) {continue;} // blank lines, headers, malformed rows
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid)) {continue;}
    procs.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : null,
      name: baseName(m[3]),
      command: m[3],
      created: NaN,
    });
  }
  return procs;
}

/**
 * True when a process-table entry belongs to the given blocked-app image name.
 *
 * Windows: image names are exact ("chrome.exe").
 * macOS:   the blocklist uses bundle names ("google chrome.app") but `comm`
 *          is "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
 *          so we match either the executable basename or the `.app` bundle
 *          component of the path.
 * @param {ProcEntry} proc
 * @param {string} targetName
 * @param {NodeJS.Platform|string} platform
 * @returns {boolean}
 */
function matchesImageName(proc, targetName, platform, scope = null) {
  const target = String(targetName || "").toLowerCase();
  if (!target || !proc) {return false;}
  const name = String(proc.name || "").toLowerCase();

  // Path scope for companions whose image name is shared across vendors (the
  // Squirrel `update.exe`). FAIL-CLOSED: no path means no match. Killing every
  // update.exe on the machine would take down unrelated software, so an
  // unverifiable path must never degrade into an image-name-only kill.
  if (scope) {
    const fullPath = String(proc.path || proc.command || "").toLowerCase();
    if (!fullPath || !fullPath.includes(String(scope).toLowerCase())) {return false;}
  }

  if (platform !== "darwin") {return name === target;}

  const bare = target.endsWith(".app") ? target.slice(0, -4) : target;
  if (name === bare || name === target) {return true;}
  const command = String(proc.command || "").toLowerCase();
  return command.includes(`/${bare}.app/`);
}

// ─── Exclusion set (the safety invariant) ────────────────────────────────────

/**
 * A parent link is only trusted when the parent is not NEWER than the child.
 * Windows keeps a dead parent's PID in the child's PPID field, and PIDs are
 * recycled — without this check a blocked app that happened to inherit the PID
 * of our long-dead launcher would be mistaken for our own ancestor (and spared
 * forever). When creation times are unavailable we trust the link.
 */
function isPlausibleParent(parent, child) {
  if (!parent || !child) {return false;}
  if (!Number.isFinite(parent.created) || !Number.isFinite(child.created)) {return true;}
  return parent.created <= child.created;
}

/**
 * Builds the set of PIDs we refuse to terminate, from a single process-table
 * snapshot:
 *   • our own PID,
 *   • its ancestor chain (cycle-guarded, creation-time validated),
 *   • every descendant of our PID (renderer/GPU helpers, spawned agent),
 *   • every process whose image name matches isOwnProcess() (a detached
 *     agent.exe is not in our tree but must never be killed),
 *   • every descendant of those own-named processes,
 *   • the OS pseudo/root PIDs (0 and 4 on Windows, 0 and 1 on macOS).
 *
 * Descendants are expanded ONLY from our own process and the own-named ones —
 * never from ancestors or from the OS roots, because launchd (PID 1) and
 * explorer.exe are ancestors of every user application and expanding them
 * would protect the very apps we are asked to close.
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
    if (!Number.isInteger(p.ppid)) {continue;}
    if (!children.has(p.ppid)) {children.set(p.ppid, []);}
    children.get(p.ppid).push(p);
  }

  const excluded = new Set([0]);
  excluded.add(platform === "darwin" ? 1 : 4); // launchd / Windows "System"

  const seeds = new Set();
  if (Number.isInteger(selfPid)) {seeds.add(selfPid);}
  for (const p of list) {
    if (isOwnProcess(p.name)) {seeds.add(p.pid);}
  }
  for (const pid of seeds) {excluded.add(pid);}

  // Ancestors of ourselves (individual PIDs only, not their subtrees).
  let cursor = byPid.get(selfPid);
  let hops = 0;
  while (cursor && hops++ < 64) {
    const parent = Number.isInteger(cursor.ppid) ? byPid.get(cursor.ppid) : null;
    if (!parent || !isPlausibleParent(parent, cursor)) {break;}
    if (excluded.has(parent.pid) && parent.pid !== selfPid) {break;} // cycle / already covered
    excluded.add(parent.pid);
    cursor = parent;
  }

  // Descendants of ourselves and of any own-named process.
  const queue = [...seeds];
  let guard = 0;
  while (queue.length && guard++ < 100000) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      if (excluded.has(child.pid)) {continue;}
      if (!isPlausibleParent(byPid.get(pid), child)) {continue;}
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
    if (seen.has(cursor.pid)) {break;}
    seen.add(cursor.pid);
    const parent = Number.isInteger(cursor.ppid) ? byPid.get(cursor.ppid) : null;
    if (!parent) {break;}
    depth++;
    cursor = parent;
  }
  return depth;
}

/**
 * Groups target PIDs into kill levels, deepest (most nested child) first, so a
 * parent is never terminated before the children it would otherwise be able to
 * notice dying. PIDs within one level are independent and killed in parallel.
 * @param {ProcEntry[]} targets
 * @param {Map<number, ProcEntry>} byPid
 * @returns {number[][]}
 */
function planKillLevels(targets, byPid) {
  const levels = new Map();
  for (const proc of targets) {
    const depth = processDepth(proc, byPid);
    if (!levels.has(depth)) {levels.set(depth, []);}
    levels.get(depth).push(proc.pid);
  }
  return [...levels.keys()]
    .sort((a, b) => b - a)
    .map((d) => levels.get(d).sort((a, b) => a - b));
}

/**
 * Ordered list of image names to terminate: companions first (they relaunch the
 * main executable), the main executable last.
 *
 * Companions come from our own static table, not from the renderer, so they are
 * not required to be on the blocklist — an updater like "zoomupdater.exe" is
 * never listed as a blocked app but must still die. They are still filtered
 * through isOwnProcess().
 * @param {string} processName
 * @param {(name: string) => string[]} getCompanions
 * @returns {string[]}
 */
function planTargetNames(processName, getCompanions) {
  const main = String(processName || "").toLowerCase();
  let companions = [];
  try {
    const raw = getCompanions(main);
    if (Array.isArray(raw)) {companions = raw;}
  } catch (err) {
    logger.warn("[processKiller] getCompanions threw:", err.message);
  }
  const cleaned = uniqueLower(companions).filter((c) => c !== main && !isOwnProcess(c));
  return [...cleaned, main];
}

/**
 * Whitelist rule for ONE kill candidate.
 *
 * Companions (launchers/updaters/tray helpers) are deliberately NOT on
 * ALL_BLOCKED_APPS — a stray helper alone must not fail a detection scan — so
 * the flat blocklist check alone would silently no-op the whole companion-first
 * ordering. The rule is therefore: killable if blocklisted, OR listed as a
 * companion OF THE TARGET CURRENTLY BEING KILLED.
 *
 * It is deliberately scoped to that one target rather than a union of every
 * companion, so the IPC surface cannot be used to kill an arbitrary helper by
 * naming an unrelated app. isOwnProcess() is applied to every candidate here,
 * companions included; the PID-level exclusion set applies to them too.
 *
 * @param {string} candidate  - image name we are about to terminate
 * @param {string} targetName - the blocked app the user asked to close
 * @param {(name: string) => boolean} isBlocked
 * @param {(name: string) => string[]} getCompanions
 * @returns {boolean}
 */
function isKillableName(candidate, targetName, isBlocked, getCompanions) {
  const name = String(candidate || "").toLowerCase();
  if (!name || isOwnProcess(name)) {return false;}
  if (isBlocked(name)) {return true;}
  try {
    const raw = getCompanions(String(targetName || "").toLowerCase());
    return Array.isArray(raw) && raw.some((c) => String(c || "").toLowerCase() === name);
  } catch {
    return false;
  }
}

/**
 * Reads companions from appList lazily and defensively — the export is being
 * added by separate work and may not exist yet. Missing export = no companions.
 * @param {string} processName
 * @returns {string[]}
 */
function getCompanionsSafe(processName) {
  try {
    // Lazy require: picks up the export as soon as it lands, no load-order coupling.
    const appList = require("../shared/appList");
    if (typeof appList.getCompanions !== "function") {return [];}
    const result = appList.getCompanions(processName);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

/**
 * Required install-path fragment for a companion, or null. Defaults to null on
 * any failure — safe, because a null scope combined with requiresPathScopeSafe()
 * makes the engine DROP the candidate rather than kill it unscoped.
 * @param {string} processName
 * @param {string} companionName
 * @returns {string|null}
 */
function getCompanionScopeSafe(processName, companionName) {
  try {
    const appList = require("../shared/appList");
    if (typeof appList.getCompanionScope !== "function") {return null;}
    return appList.getCompanionScope(processName, companionName) || null;
  } catch {
    return null;
  }
}

/**
 * True if this image name is shared across vendors and may only ever be killed
 * inside a path scope. Defaults to TRUE on failure is NOT appropriate here —
 * an unknown name is an ordinary vendor-exclusive companion — but a THROW while
 * checking is, so the catch returns true to fail closed.
 * @param {string} companionName
 * @returns {boolean}
 */
function requiresPathScopeSafe(companionName) {
  try {
    const appList = require("../shared/appList");
    if (typeof appList.requiresPathScope !== "function") {return false;}
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
  if (!r) {return { status: "error", detail: "no result" };}
  if (r.error) {return { status: "error", detail: r.error };}

  const text = `${r.stderr || ""} ${r.stdout || ""}`.toLowerCase();
  if (r.code === 0) {return { status: "killed" };}
  if (r.code === 128) {return { status: "gone" };}
  if (/not found|no such process|no running instance|not running/.test(text)) {return { status: "gone" };}
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
    found = 0, killable = 0, killed = 0,
    denied = 0, spawnErrors = 0, cleared = false, respawned = false,
  } = signals || {};

  if (found === 0) {return "already-gone";}
  if (killable === 0) {return "still-running";} // every match is inside our own tree
  if (respawned) {return "respawned";}
  if (cleared) {return "closed";}
  if (denied > 0) {return "access-denied";}
  if (killed === 0 && spawnErrors > 0) {return "spawn-error";}
  return "still-running";
}

// ─── Platform probes (the only code that touches the OS) ─────────────────────

/**
 * Full process table with parent PIDs.
 *
 * Windows uses PowerShell + Get-CimInstance rather than `wmic`: wmic is
 * deprecated since Windows 10 21H1 and is ABSENT from Windows 11 24H2 and
 * Server 2025, i.e. exactly the machines this ships to. `tasklist` is present
 * everywhere but exposes no parent PID, so it cannot support either the
 * ancestor exclusion set or children-first ordering. wmic is still tried as a
 * fallback for locked-down machines where PowerShell execution is blocked; if
 * both fail we report failure rather than killing with an unknown exclusion set.
 * @returns {Promise<{ok: boolean, procs: ProcEntry[], error?: string}>}
 */
async function listProcessTableReal(platform, timeoutMs) {
  if (platform === "darwin") {
    const r = await runCommand("ps", ["-Ao", "pid=,ppid=,comm="], timeoutMs);
    const procs = parseUnixProcessTable(r.stdout);
    if (procs.length) {return { ok: true, procs };}
    return { ok: false, procs: [], error: r.error || (r.stderr || "").trim() || "ps returned no rows" };
  }

  const psArgs = [
    "-NoProfile", "-NonInteractive", "-Command",
    // ExecutablePath is needed for path-scoped companions (the shared Squirrel
    // update.exe), and costs nothing extra on a query we already run.
    "Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,"
      + "@{n='Created';e={$_.CreationDate.Ticks}} | ConvertTo-Csv -NoTypeInformation",
  ];
  const ps = await runCommand("powershell.exe", psArgs, timeoutMs);
  let procs = parseWindowsProcessCsv(ps.stdout);
  if (procs.length) {return { ok: true, procs };}

  logger.warn("[processKiller] Get-CimInstance enumeration failed, trying wmic fallback");
  const wmic = await runCommand(
    "wmic", ["process", "get", "Name,ParentProcessId,ProcessId,CreationDate", "/FORMAT:CSV"], timeoutMs,
  );
  procs = parseWindowsProcessCsv(wmic.stdout);
  if (procs.length) {return { ok: true, procs };}

  const detail = ps.error || (ps.stderr || "").trim() || wmic.error || "no rows returned";
  return { ok: false, procs: [], error: `process enumeration failed: ${detail}` };
}

/**
 * Cheap presence probe used by verification and the relaunch watch — it only
 * needs "does any PID with this image name exist", so it avoids re-running the
 * (much slower) PowerShell enumeration once per poll.
 * @returns {Promise<{ok: boolean, pids: number[], error?: string}>}
 */
async function findPidsByNameReal(name, platform, timeoutMs) {
  if (platform === "darwin") {
    const r = await runCommand("ps", ["-Ao", "pid=,ppid=,comm="], timeoutMs);
    const procs = parseUnixProcessTable(r.stdout);
    if (!procs.length) {
      return { ok: false, pids: [], error: r.error || "ps returned no rows" };
    }
    return { ok: true, pids: procs.filter((p) => matchesImageName(p, name, platform)).map((p) => p.pid) };
  }

  const r = await runCommand("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH", "/FO", "CSV"], timeoutMs);
  if (r.error) {return { ok: false, pids: [], error: r.error };}

  const pids = [];
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("INFO:")) {continue;}
    const fields = parseCsvLine(trimmed);
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid)) {continue;}
    if (baseName(fields[0] || "").toLowerCase() !== String(name).toLowerCase()) {continue;}
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
  const r = platform === "darwin"
    ? await runCommand("kill", ["-9", String(pid)], timeoutMs)
    : await runCommand("taskkill", ["/PID", String(pid), "/F"], timeoutMs);
  return classifyPidKill(r);
}

// ─── Phase 5: elevation ──────────────────────────────────────────────────────

/**
 * Whether the CURRENT USER could satisfy an elevation prompt.
 *
 * This is deliberately "is the user an administrator", not "are we already
 * elevated". On Windows an admin running unelevated has a filtered token: the
 * BUILTIN\Administrators SID is still present (marked deny-only), and UAC will
 * show a simple consent prompt. A NON-admin instead gets a prompt demanding
 * credentials they do not have — a dead end that reads as the app being broken.
 * So we only ever offer the elevated retry to users who can actually complete it.
 *
 * Cached: group membership cannot change within a session, and this runs on a
 * user-facing path.
 *
 * @param {object} [deps]
 * @returns {Promise<boolean>}
 */
let _canElevateCache = null;
async function canElevate(deps = null) {
  const d = deps || createDefaultDeps();
  if (_canElevateCache !== null && !deps) {return _canElevateCache;}

  let result = false;
  try {
    if (d.platform === "win32") {
      // S-1-5-32-544 = BUILTIN\Administrators. Matching the SID rather than the
      // localised group name keeps this working on non-English Windows.
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

  if (!deps) {_canElevateCache = result;}
  return result;
}

/**
 * Terminates a set of PIDs through ONE elevation prompt.
 *
 * One prompt for the whole set, never one per PID — a candidate faced with six
 * consecutive UAC dialogs will cancel, and a per-PID prompt would also let the
 * app's relauncher win the race between dialogs.
 *
 * @param {number[]} pids
 * @param {object} deps
 * @returns {Promise<{status: string, detail?: string}>}
 */
async function killPidsElevatedReal(pids, deps) {
  // Injection guard: these reach a shell-interpreted command string, so accept
  // nothing but positive integers. They come from our own enumeration, but the
  // validation is what makes that guarantee local and auditable.
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (safe.length === 0) {return { status: "error", detail: "no valid PIDs" };}
  if (safe.length !== pids.length) {
    return { status: "error", detail: "refusing to elevate with a malformed PID list" };
  }

  if (deps.platform === "win32") {
    const argList = ["'/F'", ...safe.flatMap((p) => ["'/PID'", `'${p}'`])].join(",");
    const r = await deps.runProbe(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `Start-Process -FilePath taskkill.exe -ArgumentList ${argList} ` +
          "-Verb RunAs -Wait -WindowStyle Hidden",
      ],
      deps.timing.elevateTimeoutMs
    );
    const text = `${r.stdout || ""} ${r.stderr || ""}`;
    // The user declining UAC surfaces as a "canceled by the user" error.
    if (/cancel/i.test(text)) {return { status: "cancelled", detail: "elevation declined" };}
    if (r.code === 0) {return { status: "killed" };}
    return { status: "error", detail: (r.stderr || "").trim() || `exit ${r.code}` };
  }

  if (deps.platform === "darwin") {
    const r = await deps.runProbe(
      "osascript",
      ["-e", `do shell script "kill -9 ${safe.join(" ")}" with administrator privileges`],
      deps.timing.elevateTimeoutMs
    );
    const text = `${r.stdout || ""} ${r.stderr || ""}`;
    if (/User canceled|-128/i.test(text)) {return { status: "cancelled", detail: "elevation declined" };}
    if (r.code === 0) {return { status: "killed" };}
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
    killPidsElevated: (pids, deps) => killPidsElevatedReal(pids, deps),
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

  // ── Guard 1: never kill ourselves (by name) ────────────────────────────────
  if (isOwnProcess(name)) {
    logger.warn("[processKiller] blocked attempt to kill own process:", processName);
    return finish({ outcome: "own-process", error: "Cannot kill own process" });
  }

  // ── Guard 2: whitelist ─────────────────────────────────────────────────────
  if (!deps.isBlocked(name)) {
    logger.warn("[processKiller] rejected attempt to kill non-blocked process:", processName);
    return finish({ outcome: "not-blocked", error: "Process not in blocked list" });
  }

  if (deps.platform !== "win32" && deps.platform !== "darwin") {
    return finish({ outcome: "unsupported", error: `Unsupported platform: ${deps.platform}` });
  }

  // ── Snapshot the process table ────────────────────────────────────────────
  const snapshot = await deps.listProcessTable();
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.procs) || snapshot.procs.length === 0) {
    // Fail closed: without a table we cannot compute the exclusion set, and
    // killing with an unknown exclusion set could take down our own app.
    const detail = (snapshot && snapshot.error) || "process table unavailable";
    logger.error("[processKiller] refusing to kill — ", detail);
    return finish({ outcome: "spawn-error", error: detail });
  }

  const procs = snapshot.procs;
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // ── Guard 3: never kill ourselves (by PID) ────────────────────────────────
  const excluded = computeExclusionPids(procs, deps.selfPid, deps.platform);

  // ── Phase 2: companions first, main executable last ───────────────────────
  // Every candidate — companions included — is re-checked against the scoped
  // whitelist rule before it can be touched.
  const targetNames = planTargetNames(name, deps.getCompanions)
    .filter((candidate) => isKillableName(candidate, name, deps.isBlocked, deps.getCompanions));

  let found = 0;
  let protectedMatches = 0;
  const groups = targetNames.map((targetName) => {
    // A companion whose image name is shared across vendors is only killable
    // inside its owning app's install directory. If it declares a scope
    // requirement but we have no scope for THIS app, drop it entirely rather
    // than killing by name — see APP_COMPANION_SCOPES in shared/appList.js.
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
    logger.warn(`[processKiller] every ${name} PID is inside the protected process tree — refusing`);
    return finish({
      outcome: classifyKillOutcome({ found, killable: 0 }),
      error: "All matching processes belong to the protected (own) process tree",
      pidsKilled: 0,
      companionsKilled: [],
    });
  }

  // ── Phase 4: kill children before parents, group by group ─────────────────
  let killed = 0;
  let denied = 0;
  let spawnErrors = 0;
  let lastError = "";
  const companionsKilled = [];

  if (deps.elevated) {
    // Phase 5: ONE elevation prompt for every PID across every group. Prompting
    // per PID (or per group) would make a candidate accept up to a dozen UAC
    // dialogs, and would give the app's relauncher a window to win between them.
    // Ordering within the elevated call still matters less than atomicity here:
    // taskkill receives the whole set at once.
    const allPids = groups.flatMap((g) => planKillLevels(g.procs, byPid).flat());
    const r = await deps.killPidsElevated(allPids, { ...deps, timing });
    if (r.status === "killed") {
      killed = allPids.length;
      for (const g of groups) {
        if (g.procs.length && g.name !== name) {companionsKilled.push(g.name);}
      }
    } else if (r.status === "cancelled") {
      // The candidate declined the prompt. That is a deliberate choice, not a
      // failure of ours — report it as still-denied so the UI keeps offering the
      // manual route rather than looping the prompt.
      denied = allPids.length;
      lastError = r.detail || "elevation declined";
    } else {
      spawnErrors = allPids.length;
      lastError = r.detail || "elevated kill failed";
    }
  } else {
    for (const group of groups) {
      if (!group.procs.length) {continue;}
      let groupKilled = 0;
      for (const level of planKillLevels(group.procs, byPid)) {
        const results = await Promise.all(level.map((pid) => deps.killPid(pid)));
        for (const r of results) {
          if (r.status === "killed") { killed++; groupKilled++; }
          else if (r.status === "denied") { denied++; lastError = r.detail || "access denied"; }
          else if (r.status === "error") { spawnErrors++; lastError = r.detail || "kill failed"; }
          // "gone" — the PID exited between snapshot and kill; not an error.
        }
      }
      if (groupKilled > 0 && group.name !== name) {companionsKilled.push(group.name);}
    }
  }

  // ── Verification: poll until no target PID remains, or the budget expires ──
  const anyTargetAlive = async () => {
    for (const targetName of targetNames) {
      const r = await deps.findPidsByName(targetName);
      if (!r || !r.ok) {return null;} // indeterminate — treat as "still there"
      if (r.pids.length > 0) {return true;}
    }
    return false;
  };

  let cleared = false;
  const verifyAttempts = Math.max(1, Math.ceil(timing.verifyTimeoutMs / timing.verifyPollMs));
  for (let i = 0; i < verifyAttempts; i++) {
    await deps.sleep(timing.verifyPollMs);
    const alive = await anyTargetAlive();
    if (alive === false) { cleared = true; break; }
    if (alive === null) {lastError = lastError || "could not verify — process query failed";}
  }

  // ── Phase 3: relaunch watch — the actual reported bug ─────────────────────
  let respawned = false;
  if (cleared) {
    const watchAttempts = Math.max(1, Math.ceil(timing.relaunchWatchMs / timing.relaunchPollMs));
    for (let i = 0; i < watchAttempts; i++) {
      await deps.sleep(timing.relaunchPollMs);
      const alive = await anyTargetAlive();
      if (alive === true) { respawned = true; break; }
    }
  }

  // ── Phase 1: structured outcome ───────────────────────────────────────────
  const outcome = classifyKillOutcome({ found, killable, killed, denied, spawnErrors, cleared, respawned });
  const result = finish({
    outcome,
    pidsKilled: killed,
    companionsKilled,
    ...(outcome === "closed" || outcome === "already-gone" ? {} : { error: describeFailure(outcome, lastError, protectedMatches) }),
  });

  logger[result.success ? "info" : "warn"](
    `[processKiller] ${name} → ${outcome} (pids killed: ${killed}, companions: ${companionsKilled.join(", ") || "none"})`,
  );
  return result;
}

/**
 * Technical diagnostic string for a failed kill. NOT user-facing copy — the
 * renderer keys its message off `outcome`.
 */
function describeFailure(outcome, lastError, protectedMatches) {
  switch (outcome) {
    case "respawned":
      return "Process reappeared after termination (relaunched by a background service)";
    case "access-denied":
      return lastError || "Access denied — process is elevated or protected";
    case "spawn-error":
      return lastError || "Termination command could not be executed";
    default:
      return lastError
        || (protectedMatches > 0
          ? "Process still running and is inside the protected process tree"
          : "Process still running after termination");
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
 * Phase 5: retry a kill with elevated privileges, behind ONE consent prompt.
 *
 * Deliberately a separate entry point rather than an automatic fallback inside
 * killSingleProcess(). Elevation shows the candidate a system dialog, so it must
 * only ever happen because they explicitly asked for it — never as a silent
 * retry, and never in a loop. The caller is responsible for offering it only
 * when canElevate() is true and only outside an active interview.
 *
 * Every guard from the normal path still applies: name whitelist, self-process
 * protection, PID exclusion set, companion path scoping.
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
    classifyPidKill,
    classifyKillOutcome,
    describeFailure,
    DEFAULT_TIMING,
  },
};
