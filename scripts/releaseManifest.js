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
 * Tags must be `vX.Y.Z`. The workflow only triggers on `v*`, so a tag like
 * `1.2.5` silently skips CI — that is how a release went out holding nothing
 * but another version's blockmap.
 *
 * @param {string} tag
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyTagFormat(tag) {
  const problems = [];
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ""))) {
    problems.push(`tag ${tag} is not vX.Y.Z — the release workflow only triggers on v* tags`);
  }
  return { ok: problems.length === 0, problems };
}

/** `1.2.10` → [1, 2, 10], or null if it isn't three numbers. */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Standard semver ordering over the numeric triple. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * A tag must be newer than everything already published. GitHub moves its
 * "latest" pointer to the most recent release, so publishing an older version
 * afterwards offers existing clients a downgrade.
 *
 * @param {string} tag
 * @param {string[]} publishedTags tags of existing non-draft releases
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyVersionOrder(tag, publishedTags) {
  const problems = [];
  const version = versionFromTag(tag);

  for (const other of publishedTags || []) {
    if (other === tag) {
      continue;
    }
    if (compareVersions(versionFromTag(other), version) >= 0) {
      problems.push(`${other} is already published and is not older than ${tag}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Checks one update manifest against the assets actually uploaded.
 * @param {string} tag
 * @param {string} manifestName "latest.yml" (Windows) or "latest-mac.yml"
 * @param {string|null} manifestText
 * @param {Map<string, {name: string, size: number}>} byName
 * @returns {string[]} problems, empty when the manifest is usable
 */
function checkManifest(tag, manifestName, manifestText, byName) {
  const problems = [];

  if (!byName.has(manifestName)) {
    problems.push(
      `${manifestName} is missing — electron-updater cannot detect this release at all`
    );
  }

  if (!manifestText) {
    problems.push(`${manifestName} could not be read`);
    return problems;
  }

  const manifest = parseLatestYml(manifestText);
  const expected = versionFromTag(tag);

  if (!manifest.version) {
    problems.push(`${manifestName} has no version field`);
  } else if (manifest.version !== expected) {
    problems.push(
      `${manifestName} declares version ${manifest.version} but the tag is ${tag} (expected ${expected}) — clients would be offered the wrong build`
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
    problems.push(`${manifestName} references no installer`);
  }

  for (const name of referenced) {
    const asset = byName.get(name);
    if (!asset) {
      problems.push(`${manifestName} references ${name} but it was not uploaded`);
      continue;
    }
    const declared = manifest.files.find((f) => f.url === name);
    if (declared && declared.size !== null && declared.size !== asset.size) {
      problems.push(
        `${name} is ${asset.size} B but ${manifestName} declares ${declared.size} B — the upload is truncated`
      );
    }
  }

  return problems;
}

/**
 * @param {string} tag
 * @param {string|null} manifestText latest.yml contents, or null if absent.
 * @param {{name: string, size: number}[]} assets
 * @param {string|null} [macManifestText] latest-mac.yml, checked only when a dmg shipped
 * @returns {{ ok: boolean, problems: string[] }}
 */
function verifyRelease(tag, manifestText, assets, macManifestText = null) {
  const byName = new Map((assets || []).map((a) => [a.name, a]));
  const problems = checkManifest(tag, "latest.yml", manifestText, byName);

  // Only demand the macOS manifest once a dmg is actually being published —
  // otherwise every Windows-only release fails on a platform it never built.
  if ([...byName.keys()].some((name) => name.endsWith(".dmg"))) {
    problems.push(...checkManifest(tag, "latest-mac.yml", macManifestText, byName));
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  parseLatestYml,
  versionFromTag,
  verifyRelease,
  verifyTagFormat,
  parseVersion,
  compareVersions,
  verifyVersionOrder,
};
