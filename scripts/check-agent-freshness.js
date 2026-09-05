/**
 * Guards the `dist` scripts from silently shipping a stale resources/agent binary.
 *
 * scripts/build_agent.py records the SHA-256 of the agent.py it compiled in
 * resources/agent.build.json. If that no longer matches agent.py on disk, the
 * binary predates the source and `dist` would package the old one. This used to
 * compare mtimes, which a checkout reorders. `build:full` runs build:agent right
 * before packaging and is never affected — only the `dist` path, which packages
 * whatever is already there.
 */

"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const AGENT_SRC = path.join(ROOT, "agent.py");

// Which binary to check is a property of the PACKAGING TARGET, not the host —
// electron-builder can cross-build, and agent.exe says nothing about a dmg.
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : hostTarget();
const bin = target === "win" ? "agent.exe" : "agent";
const AGENT_BIN = path.join(ROOT, "resources", bin);
const STAMP = path.join(ROOT, "resources", "agent.build.json");

function hostTarget() {
  return process.platform === "win32" ? "win" : "mac";
}

const rel = (p) => path.relative(ROOT, p);

function fail(message) {
  console.error(`[check-agent-freshness] ${message}`);
  process.exit(1);
}

function main() {
  if (target !== "win" && target !== "mac") {
    fail(`unknown --target=${target} (expected win or mac)`);
  }

  if (!fs.existsSync(AGENT_BIN)) {
    fail(
      `${rel(AGENT_BIN)} does not exist. Run \`pnpm run build:agent\` on a ` +
        `${target === "win" ? "Windows" : "macOS"} machine first.`
    );
  }

  if (!fs.existsSync(STAMP)) {
    fail(
      `${rel(STAMP)} is missing, so the binary's source cannot be identified. ` +
        "Rebuild with `pnpm run build:agent`."
    );
  }

  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(STAMP, "utf8"));
  } catch (err) {
    fail(`${rel(STAMP)} is unreadable (${err.message}). Rebuild with \`pnpm run build:agent\`.`);
  }

  const actual = crypto.createHash("sha256").update(fs.readFileSync(AGENT_SRC)).digest("hex");

  if (stamp.binary && stamp.binary !== bin) {
    fail(
      `${rel(STAMP)} describes ${stamp.binary}, not the ${bin} this ${target} build needs. ` +
        `Build the ${target} agent on that platform.`
    );
  }

  if (stamp.source_sha !== actual) {
    fail(
      `${rel(AGENT_BIN)} was built from a different agent.py ` +
        `(binary ${String(stamp.source_sha).slice(0, 12)}, source ${actual.slice(0, 12)}). ` +
        "Run `pnpm run build:agent` before packaging, or use `pnpm run build:full`."
    );
  }

  console.log(`[check-agent-freshness] ${bin} matches agent.py (${actual.slice(0, 12)}).`);
}

main();
