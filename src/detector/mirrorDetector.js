const { getAllBlocked } = require("../shared/blocklist");

/**
 * Mirroring / casting detection.
 * @returns {Promise<{ detected: boolean, status: string, reason: string, details: object }>}
 */
async function detectMirroring() {
  const processes = await checkProcesses();

  // A failed scan must never read as clean.
  if (processes.status === "indeterminate") {
    return {
      detected: false,
      status: "indeterminate",
      reason: "Process scan could not be completed",
      details: { processes: [] },
    };
  }

  const detected = processes.found.length > 0;

  return {
    detected,
    status: detected ? "violation" : "clear",
    reason: detected ? `Casting/remote apps: ${processes.found.join(", ")}` : "",
    details: {
      processes: processes.found,
    },
  };
}

let _processCheckCache = null;
let _processCheckTime = 0;
const PROCESS_CACHE_TTL_MS = 3000;

// Bumped on invalidation so a probe that started earlier can't re-seed the cache.
let _cacheEpoch = 0;

/** Blocked names that exactly match a running macOS command, ignoring .app/.exe. */
function matchMacCommands(stdout, blocked) {
  const running = new Set(
    stdout
      .split("\n")
      .map((l) => l.trim().toLowerCase().split("/").pop())
      .filter(Boolean)
  );
  return blocked.filter((app) => running.has(app.toLowerCase().replace(/\.(app|exe)$/, "")));
}

/** Blocked names that exactly match an image name in `tasklist /FO CSV /NH` output. */
function matchWindowsImages(stdout, blocked) {
  const running = new Set();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^"([^"]+)"/);
    if (m) {
      running.add(m[1].toLowerCase());
    }
  }
  return blocked.filter((app) => running.has(app.toLowerCase()));
}

/**
 * Lists running processes and returns the blocked ones. A failed listing is
 * "indeterminate" and never cached.
 * @returns {Promise<{ found: string[], status: string }>}
 */
function checkProcesses() {
  const now = Date.now();
  if (_processCheckCache && now - _processCheckTime < PROCESS_CACHE_TTL_MS) {
    return Promise.resolve(_processCheckCache);
  }
  const startedEpoch = _cacheEpoch;
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    const isMac = process.platform === "darwin";

    const done = (err, stdout) => {
      if (err) {
        return resolve({ found: [], status: "indeterminate" });
      }
      const match = isMac ? matchMacCommands : matchWindowsImages;
      const result = { found: match(String(stdout), getAllBlocked()), status: "clear" };
      if (startedEpoch === _cacheEpoch) {
        _processCheckCache = result;
        _processCheckTime = Date.now();
      }
      resolve(result);
    };

    if (isMac) {
      execFile("ps", ["-Aco", "comm="], done);
    } else {
      execFile("tasklist", ["/FO", "CSV", "/NH"], done);
    }
  });
}

/** Makes the next checkProcesses() run a fresh scan, including one already in flight. */
function invalidateProcessCache() {
  _processCheckCache = null;
  _processCheckTime = 0;
  _cacheEpoch += 1;
}

module.exports = detectMirroring;
module.exports.checkProcesses = checkProcesses;
module.exports.invalidateProcessCache = invalidateProcessCache;
