const { ALL_BLOCKED_APPS } = require("../shared/appList");

/**
 * Mirroring / casting detection.
 *
 * Phase 0: the resolution + monitor-count heuristic was removed. Multi-monitor
 * detection now lives entirely in hdmiDetector.js via the native Electron
 * `screen` API (reliable, no PowerShell). Resolution alone was never a sound
 * signal — modern laptops ship QHD/4K panels — and the PowerShell probe it
 * required was a flakiness + false-positive source. Mirroring is now inferred
 * purely from running casting/remote-desktop processes.
 *
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

// =====================
// PROCESS CHECK (SMART)
// =====================

// ── Result cache ──────────────────────────────────────────────────────────────
// Avoids spawning a new tasklist/ps process within a short burst (e.g. the
// pre-proceed watcher reads this; preflight warmed it).
let _processCheckCache = null;   // { found: string[], status: string }
let _processCheckTime  = 0;       // Date.now() of last successful run
const PROCESS_CACHE_TTL_MS = 3000;

// Cache epoch. Incremented by invalidateProcessCache(). A probe records the
// epoch it started under and refuses to publish its result if the epoch has
// moved on since — i.e. someone invalidated the cache while it was in flight.
//
// WHY: the pre-proceed monitor polls every 2s, so a tasklist spawn it started a
// moment before a preflight scan began could land AFTER the scan's
// invalidateProcessCache() and silently re-seed the cache with a pre-scan
// snapshot. The scan would then "freshly" read data captured before the
// candidate closed the offending app. Without the epoch, invalidation is only
// advisory; with it, "invalidate then read" genuinely means uncached data.
let _cacheEpoch = 0;

/**
 * Phase 4: row-anchored process matching to cut false positives.
 *
 * The previous implementation regex-matched blocked names against the entire
 * `tasklist` stdout blob, which had two problems:
 *   - default `tasklist` table output TRUNCATES the image name to 25 chars,
 *     so long exe names silently slipped through (false negative);
 *   - matching across the whole blob could cross-match unrelated columns/lines
 *     (false positive).
 *
 * We now enumerate one process per row and compare the EXACT image-name field:
 *   - Windows: `tasklist /FO CSV /NH` → first CSV field is the (untruncated)
 *     image name. Exact, case-insensitive Set membership against the blocked list.
 *   - macOS:   `ps -Aco comm=` → bare command names; match the blocked name
 *     (minus its .app/.exe suffix) against the process basename.
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
        if (err) { return resolve({ found: [], status: "indeterminate" }); }

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
      if (err) { return resolve({ found: [], status: "indeterminate" }); }

      const running = new Set();
      for (const line of stdout.split("\n")) {
        const m = line.trim().match(/^"([^"]+)"/); // first CSV field = image name
        if (m) { running.add(m[1].toLowerCase()); }
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
  _processCheckTime  = 0;
  _cacheEpoch += 1;
}

module.exports = detectMirroring;
// Named exports so callers can run the process scan in isolation.
module.exports.checkProcesses = checkProcesses;
module.exports.invalidateProcessCache = invalidateProcessCache;
