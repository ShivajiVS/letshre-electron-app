/**
 * Guards `pnpm run dist` from silently shipping a stale resources/agent.exe.
 *
 * agent.py has no version stamp written next to the binary it produces (see
 * scripts/build_agent.py), so the only signal available here is mtime: if
 * agent.py was edited after the bundled binary was last built, `dist` almost
 * certainly means to ship the old one by accident. `build:full` (which runs
 * build:agent right before packaging) is never affected by this — only the
 * `dist` path, which packages whatever is already on disk.
 */

"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const AGENT_SRC = path.join(ROOT, "agent.py");
const bin = process.platform === "win32" ? "agent.exe" : "agent";
const AGENT_BIN = path.join(ROOT, "resources", bin);

function main() {
  if (!fs.existsSync(AGENT_BIN)) {
    console.error(
      `[check-agent-freshness] ${path.relative(ROOT, AGENT_BIN)} does not exist. ` +
        "Run `pnpm run build:agent` first."
    );
    process.exit(1);
  }

  const srcMtime = fs.statSync(AGENT_SRC).mtimeMs;
  const binMtime = fs.statSync(AGENT_BIN).mtimeMs;

  if (binMtime < srcMtime) {
    console.error(
      `[check-agent-freshness] ${path.relative(ROOT, AGENT_BIN)} is older than agent.py — ` +
        "it was not rebuilt after the latest source change. Run `pnpm run build:agent` " +
        "before packaging, or use `pnpm run build:full` which does this automatically."
    );
    process.exit(1);
  }

  console.log("[check-agent-freshness] resources/agent binary is up to date.");
}

main();
