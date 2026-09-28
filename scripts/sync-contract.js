#!/usr/bin/env node
/**
 * Copies contract/interview-contract.json into an interview-site checkout.
 *
 * Usage: node scripts/sync-contract.js <path-to-site-checkout>
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE = path.join(__dirname, "..", "contract", "interview-contract.json");
const TARGET_REL = path.join("src", "contract", "interview-contract.json");

function main(argv) {
  const siteRoot = argv[2];
  if (!siteRoot) {
    console.error("Usage: node scripts/sync-contract.js <path-to-site-checkout>");
    return 1;
  }
  const root = path.resolve(siteRoot);
  if (!fs.existsSync(path.join(root, "package.json")) || !fs.existsSync(path.join(root, "src"))) {
    console.error(`${root} doesn't look like the interview site (no package.json or src/).`);
    return 1;
  }
  JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const target = path.join(root, TARGET_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(SOURCE, target);
  console.log(`Copied contract to ${target}`);
  return 0;
}

process.exitCode = main(process.argv);
