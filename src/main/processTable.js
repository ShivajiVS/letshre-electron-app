/**
 * Parsing and matching over an OS process table. Pure string work — no spawn,
 * no logger, no blocklist — so it unit-tests without touching the OS. The code
 * that runs the commands feeding this lives in processKiller.js.
 */

"use strict";

/** Basename that understands both `/` and `\` regardless of host platform. */
function baseName(p) {
  const parts = String(p || "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

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
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
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
  if (!raw) {
    return NaN;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const m = raw.match(/^(\d{14})/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Parses headered CSV process output (PowerShell Get-CimInstance or wmic) —
 * both emit a ProcessId/ParentProcessId/Name header row, so one parser
 * covers both. Rows without a usable PID are dropped.
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
      if (pidIdx === -1) {
        continue;
      } // still looking for the header row
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
    if (!Number.isInteger(pid) || pid < 0) {
      continue;
    }

    const ppidRaw = cols.ppid >= 0 ? Number(fields[cols.ppid]) : NaN;
    const created = cols.created >= 0 ? parseCreated(fields[cols.created]) : NaN;
    // Left "" rather than guessed when absent — a path-scoped companion must
    // fail to match on an unknown path, never fall back to name-only.
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
    if (!m) {
      continue;
    } // blank lines, headers, malformed rows
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid)) {
      continue;
    }
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
 * Windows image names are exact ("chrome.exe"). macOS blocklist uses bundle
 * names ("google chrome.app") but `comm` is a full path, so we match either
 * the executable basename or the `.app` bundle component.
 * @param {ProcEntry} proc
 * @param {string} targetName
 * @param {NodeJS.Platform|string} platform
 * @returns {boolean}
 */
function matchesImageName(proc, targetName, platform, scope = null) {
  const target = String(targetName || "").toLowerCase();
  if (!target || !proc) {
    return false;
  }
  const name = String(proc.name || "").toLowerCase();

  // Path scope for companions with a shared image name across vendors (e.g.
  // Squirrel's update.exe). Fail-closed: no path means no match — killing
  // every update.exe on the machine would take down unrelated software.
  if (scope) {
    const fullPath = String(proc.path || proc.command || "").toLowerCase();
    if (!fullPath || !fullPath.includes(String(scope).toLowerCase())) {
      return false;
    }
  }

  if (platform !== "darwin") {
    return name === target;
  }

  const bare = target.endsWith(".app") ? target.slice(0, -4) : target;
  if (name === bare || name === target) {
    return true;
  }
  const command = String(proc.command || "").toLowerCase();
  return command.includes(`/${bare}.app/`);
}

module.exports = {
  baseName,
  parseCsvLine,
  parseCreated,
  parseWindowsProcessCsv,
  parseUnixProcessTable,
  matchesImageName,
};
