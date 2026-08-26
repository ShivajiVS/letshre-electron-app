/**
 * Pure checks over a GitHub release's contents, used by scripts/verifyRelease.js
 * to decide whether a build is safe to publish.
 *
 * A release is only useful to electron-updater if latest.yml is present AND
 * every installer it names was actually uploaded. Both have already shipped
 * broken: v1.2.3 published with only a .exe.blockmap (no latest.yml, no
 * installer), and v1.2.2's manifest declared version 1.2.1 because its tag
 * pointed at the wrong commit. Neither failed the build.
 *
 * No network or fs here so it runs under plain `node --test`.
 */

"use strict";

/**
 * Minimal reader for the fixed shape electron-builder emits. Deliberately not a
 * general YAML parser — it only understands `version`, `path` and the `files`
 * list, and reports anything it cannot read rather than guessing.
 *
 * @param {string} text
 * @returns {{ version: string|null, path: string|null, files: {url: string, size: number|null}[] }}
 */
function parseLatestYml(text) {
  const result = { version: null, path: null, files: [] };
  if (typeof text !== "string") {
    return result;
  }

  let inFiles = false;
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
      continue;
    }

    const topLevel = /^([A-Za-z][\w]*):\s*(.*)$/.exec(rawLine);
    if (topLevel && !rawLine.startsWith(" ")) {
      if (current) {
        result.files.push(current);
        current = null;
      }
      const [, key, value] = topLevel;
      inFiles = key === "files";
      if (key === "version") {
        result.version = _unquote(value);
      } else if (key === "path") {
        result.path = _unquote(value);
      }
      continue;
    }

    if (!inFiles) {
      continue;
    }

    const entryStart = /^\s*-\s*url:\s*(.+)$/.exec(rawLine);
    if (entryStart) {
      if (current) {
        result.files.push(current);
      }
      current = { url: _unquote(entryStart[1]), size: null };
      continue;
    }

    const sizeLine = /^\s+size:\s*(\d+)\s*$/.exec(rawLine);
    if (sizeLine && current) {
      current.size = Number(sizeLine[1]);
    }
  }

  if (current) {
    result.files.push(current);
  }
  return result;
}

function _unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

/** `v1.2.3` → `1.2.3`. */
function versionFromTag(tag) {
  return String(tag || "").replace(/^v/, "");
}

/**
 * @param {string} tag
 * @param {string|null} manifestText latest.yml contents, or null if absent.
 * @param {{name: string, size: number}[]} assets
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyRelease(tag, manifestText, assets) {
  const problems = [];
  const byName = new Map((assets || []).map((a) => [a.name, a]));

  if (!byName.has("latest.yml")) {
    problems.push("latest.yml is missing — electron-updater cannot detect this release at all");
  }

  if (!manifestText) {
    problems.push("latest.yml could not be read");
    return { ok: false, problems };
  }

  const manifest = parseLatestYml(manifestText);
  const expected = versionFromTag(tag);

  if (!manifest.version) {
    problems.push("latest.yml has no version field");
  } else if (manifest.version !== expected) {
    problems.push(
      `latest.yml declares version ${manifest.version} but the tag is ${tag} (expected ${expected}) — clients would be offered the wrong build`
    );
  }

  const referenced = new Set();
  if (manifest.path) {
    referenced.add(manifest.path);
  }
  for (const file of manifest.files) {
    referenced.add(file.url);
  }

  if (referenced.size === 0) {
    problems.push("latest.yml references no installer");
  }

  for (const name of referenced) {
    const asset = byName.get(name);
    if (!asset) {
      problems.push(`latest.yml references ${name} but it was not uploaded`);
      continue;
    }
    const declared = manifest.files.find((f) => f.url === name);
    if (declared && declared.size !== null && declared.size !== asset.size) {
      problems.push(
        `${name} is ${asset.size} B but latest.yml declares ${declared.size} B — the upload is truncated`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = { parseLatestYml, versionFromTag, verifyRelease };
