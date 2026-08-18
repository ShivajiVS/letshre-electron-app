const { ALL_BLOCKED_APPS } = require("../shared/appList");

/**
 * Mirroring / casting detection.
 * @returns {Promise<{ detected: boolean, status: string, reason: string, details: object }>}
 */
async function detectMirroring() {
  const processes = await checkProcesses();

  // Propagate an inconclusive process scan upward so the caller's fail-closed
  // policy can react — never silently treat a failed probe as "clean".
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

let _processCheckCache = null; // { found: string[], status: string }
let _processCheckTime = 0; // Date.now() of last successful run
const PROCESS_CACHE_TTL_MS = 3000;

// Cache epoch, bumped by invalidateProcessCache(). A probe records the epoch it
// started under and drops its result if the epoch moved on before it finished —
// otherwise an in-flight tasklist spawned just before a scan invalidates could
// land after and re-seed the cache with stale (pre-close) data.
let _cacheEpoch = 0;

/**
 * Row-anchored process matching against the blocked-app list, one process per
 * row rather than regexing the whole stdout blob (which let long exe names slip
 * past `tasklist`'s 25-char truncation and could cross-match unrelated lines).
 *
 * Windows: `tasklist /FO CSV /NH` — first field is the untruncated image name,
 * exact case-insensitive match. macOS: `ps -Aco comm=` — bare command names,
 * matched against the blocked name minus its .app/.exe suffix.
 *
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

    const finish = (found) => {
      const result = { found, status: "clear" };
      // Only publish to the cache if nobody invalidated while we were probing —
      // otherwise this snapshot predates the invalidation and must not be served
      // to whoever asked for fresh data.
      if (startedEpoch === _cacheEpoch) {
        _processCheckCache = result;
        _processCheckTime = Date.now();
      }
      resolve(result);
    };

    if (process.platform === "darwin") {
      execFile("ps", ["-Aco", "comm="], (err, stdout) => {
        // Fail-CLOSED: a failed listing is "indeterminate", not "clean" (uncached).
        if (err) {
          return resolve({ found: [], status: "indeterminate" });
        }

        const running = stdout
          .split("\n")
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean);

        const found = ALL_BLOCKED_APPS.filter((app) => {
          const needle = app.replace(/\.(app|exe)$/i, "");
          return running.some((line) => {
            const base = line.split("/").pop();
            return base === needle || base.endsWith(` ${needle}`) || base.includes(needle);
          });
        });
        finish(found);
      });
      return;
    }

    // Windows: CSV is untruncated and one process per row.
    execFile("tasklist", ["/FO", "CSV", "/NH"], (err, stdout) => {
      if (err) {
        return resolve({ found: [], status: "indeterminate" });
      }

      const running = new Set();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^"([^"]+)"/); // first CSV field = image name
        if (m) {
          running.add(m[1].toLowerCase());
        }
      }

      // Exact membership — no substring/partial matches.
      const found = ALL_BLOCKED_APPS.filter((app) => running.has(app.toLowerCase()));
      finish(found);
    });
  });
}

/**
 * Clears the process-check cache so the next call always runs a fresh scan.
 * Call this when the user triggers a Recheck so the preflight gets live data.
 *
 * Bumping the epoch also invalidates any probe that is CURRENTLY in flight, so a
 * concurrent poller cannot re-seed the cache with a pre-invalidation snapshot.
 */
function invalidateProcessCache() {
  _processCheckCache = null;
  _processCheckTime = 0;
  _cacheEpoch += 1;
}

module.exports = detectMirroring;
// Named exports so callers can run the process scan in isolation.
module.exports.checkProcesses = checkProcesses;
module.exports.invalidateProcessCache = invalidateProcessCache;
