#!/usr/bin/env node
/**
 * Verifies the release for a tag and, with --publish, flips it out of draft
 * only once it checks out.
 *
 * electron-builder publishes as a draft, so a build that uploads some assets
 * and dies leaves a draft that looks plausible in the UI. Publishing by hand is
 * how v1.2.3 went out with only a .exe.blockmap. This makes publication a
 * consequence of passing verification rather than a separate manual step.
 *
 * Usage: node scripts/verifyRelease.js <tag> [--publish]
 * Env:   GH_TOKEN (required), GITHUB_REPOSITORY (owner/repo)
 */

"use strict";

const { verifyRelease } = require("./releaseManifest");

const API = "https://api.github.com";

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

async function gh(path, options = {}) {
  const token = process.env.GH_TOKEN;
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${options.method || "GET"} ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Drafts are not addressable by tag, so the list has to be scanned. Only the
 * first page is fetched: the release being verified was created moments ago.
 */
async function findRelease(repo, tag) {
  const releases = await gh(`/repos/${repo}/releases?per_page=100`);
  return releases.find((r) => r.tag_name === tag) || null;
}

/**
 * Fetched through the API rather than the public download URL so the asset can
 * still be read while the release is a draft.
 */
async function fetchAssetText(repo, assetId) {
  const res = await fetch(`${API}/repos/${repo}/releases/assets/${assetId}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) {
    return null;
  }
  return res.text();
}

async function main() {
  const [tag, ...flags] = process.argv.slice(2);
  const shouldPublish = flags.includes("--publish");
  const repo = process.env.GITHUB_REPOSITORY;

  if (!tag) {
    fail("usage: node scripts/verifyRelease.js <tag> [--publish]");
  }
  if (!process.env.GH_TOKEN) {
    fail("GH_TOKEN is not set");
  }
  if (!repo) {
    fail("GITHUB_REPOSITORY is not set");
  }

  const release = await findRelease(repo, tag);
  if (!release) {
    fail(`no release found for tag ${tag} — did electron-builder publish?`);
  }

  const assets = release.assets.map((a) => ({ name: a.name, size: a.size, id: a.id }));
  console.log(`Release ${tag} (draft: ${release.draft}) has ${assets.length} asset(s):`);
  for (const asset of assets) {
    console.log(`  ${asset.name} — ${asset.size} B`);
  }

  const manifestAsset = assets.find((a) => a.name === "latest.yml");
  const manifestText = manifestAsset ? await fetchAssetText(repo, manifestAsset.id) : null;

  const { ok, problems } = verifyRelease(tag, manifestText, assets);
  if (!ok) {
    console.error("\nRelease verification FAILED:");
    for (const problem of problems) {
      console.error(`  ✖ ${problem}`);
    }
    fail(
      release.draft
        ? "left as a draft — fix the build and re-run rather than publishing this"
        : "this release is already public and is broken for auto-update"
    );
  }

  console.log("\n✔ latest.yml is present, matches the tag, and every installer it names uploaded.");

  if (!shouldPublish) {
    return;
  }
  if (!release.draft) {
    console.log("Already published — nothing to do.");
    return;
  }

  await gh(`/repos/${repo}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ draft: false }),
  });
  console.log(`✔ Published ${tag}.`);
}

main().catch((err) => fail(err.message));
