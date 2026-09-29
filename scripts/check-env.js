/**
 * electron-builder beforePack hook. The .env beside the executable is copied
 * from the repo root, so a local build would otherwise ship whatever the
 * developer runs against, such as an interview site on localhost.
 * Set ALLOW_DEV_ENV=1 to package a test build against local hosts on purpose.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { validateEmail } = require("../src/shared/authValidators");

const REQUIRED = ["INTERVIEW_FRONTEND_BASE_URL", "API_BASE_URL"];
// Checked only when set.
const OPTIONAL = ["SUPPORT_URL"];
const OPTIONAL_PATHS = ["PREFLIGHT_POLICY_PATH", "PREFLIGHT_TELEMETRY_PATH"];
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.+\.local)$/i;

function parseEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return values;
}

/** @returns {string[]} one message per problem, empty when the file is fit to ship */
function checkEnv(text) {
  const values = parseEnv(text);
  const problems = [];
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    const value = values[key];
    if (!value) {
      if (REQUIRED.includes(key)) {
        problems.push(`${key} is not set`);
      }
      continue;
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      problems.push(`${key} is not a valid URL: ${value}`);
      continue;
    }
    if (LOCAL_HOST.test(url.hostname)) {
      problems.push(`${key} points at a local host: ${value}`);
    } else if (url.protocol !== "https:") {
      problems.push(`${key} must use https: ${value}`);
    }
  }
  if (values.SUPPORT_EMAIL && !validateEmail(values.SUPPORT_EMAIL).valid) {
    problems.push(`SUPPORT_EMAIL is not an email address: ${values.SUPPORT_EMAIL}`);
  }
  for (const key of OPTIONAL_PATHS) {
    const value = values[key];
    if (value && !/^\/\S*$/.test(value)) {
      problems.push(`${key} must be a path starting with "/": ${value}`);
    }
  }
  return problems;
}

function beforePack() {
  if (process.env.ALLOW_DEV_ENV === "1") {
    console.warn("[check-env] ALLOW_DEV_ENV=1 — packaging without checking .env");
    return;
  }
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) {
    throw new Error("[check-env] .env is missing — the packaged app has no host fallback");
  }
  const problems = checkEnv(fs.readFileSync(file, "utf8"));
  if (problems.length > 0) {
    throw new Error(
      `[check-env] .env is not fit to ship:\n  - ${problems.join("\n  - ")}\n` +
        "Point it at the production hosts, or set ALLOW_DEV_ENV=1 for a local test build."
    );
  }
}

module.exports = beforePack;
module.exports.default = beforePack;
module.exports.checkEnv = checkEnv;
