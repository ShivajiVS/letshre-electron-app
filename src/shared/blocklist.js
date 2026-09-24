// The blocklist in force right now: appList's built-ins, adjusted by an optional
// per-company policy. Every reader goes through here so detection, the cards,
// the kill whitelist and the page's app list can never disagree.

"use strict";

const {
  MEETING_APPS,
  SCREEN_SHARING_APPS,
  CASTING_APPS,
  BROWSER_APPS,
  AI_CHEATING_APPS,
  APP_DISPLAY_NAMES,
} = require("./appList");

const BUILT_IN = {
  meeting: MEETING_APPS,
  screen: SCREEN_SHARING_APPS,
  wireless: CASTING_APPS,
  browser: BROWSER_APPS,
  ai: AI_CHEATING_APPS,
};
const CATEGORIES = Object.keys(BUILT_IN);

const NAME_PATTERN = /^[\w.\- ]{1,120}$/;
const MAX_ENTRIES = 200;
const MAX_DISPLAY_NAME = 80;

// A policy may never make the app flag or kill the OS itself, or this app.
const PROTECTED_NAMES = new Set([
  "system",
  "explorer.exe",
  "svchost.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "lsass.exe",
  "services.exe",
  "smss.exe",
  "dwm.exe",
  "conhost.exe",
  "taskmgr.exe",
  "electron.exe",
  "electron",
  "agent.exe",
  "agent",
  "launchd",
  "kernel_task",
  "windowserver",
  "loginwindow",
  "finder",
  "finder.app",
  "dock",
  "dock.app",
  "systemuiserver",
]);
const PROTECTED_PREFIXES = ["letshyre secure interview", "letshyre-secure-interview"];

function isProtected(name) {
  return PROTECTED_NAMES.has(name) || PROTECTED_PREFIXES.some((p) => name.startsWith(p));
}

function cleanName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().toLowerCase();
  return NAME_PATTERN.test(name) && !isProtected(name) ? name : null;
}

function cleanDisplayName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\p{Cc}/gu, "").trim();
  return text ? text.slice(0, MAX_DISPLAY_NAME) : null;
}

/**
 * Keeps only the well-formed parts of a policy response; anything else is dropped.
 * @param {unknown} raw
 * @returns {{allow: string[], block: {name: string, category: string, displayName?: string}[],
 *   dropped: number} | null} null when the response isn't a policy at all
 */
function validatePolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const allowIn = raw.allow === undefined ? [] : raw.allow;
  const blockIn = raw.block === undefined ? [] : raw.block;
  if (!Array.isArray(allowIn) || !Array.isArray(blockIn)) {
    return null;
  }

  let dropped =
    Math.max(0, allowIn.length - MAX_ENTRIES) + Math.max(0, blockIn.length - MAX_ENTRIES);

  const allow = new Set();
  for (const entry of allowIn.slice(0, MAX_ENTRIES)) {
    const name = cleanName(entry);
    if (name) {
      allow.add(name);
    } else {
      dropped += 1;
    }
  }

  const block = new Map();
  for (const entry of blockIn.slice(0, MAX_ENTRIES)) {
    const name = cleanName(entry?.name);
    const category = entry?.category;
    if (!name || !CATEGORIES.includes(category) || block.has(name)) {
      dropped += 1;
      continue;
    }
    const displayName = cleanDisplayName(entry.displayName);
    block.set(name, displayName ? { name, category, displayName } : { name, category });
  }

  return { allow: [...allow], block: [...block.values()], dropped };
}

function build(policy) {
  const allow = new Set(policy?.allow || []);
  const lists = {};
  for (const id of CATEGORIES) {
    lists[id] = id === "ai" ? [...BUILT_IN[id]] : BUILT_IN[id].filter((n) => !allow.has(n));
  }

  const displayNames = { ...APP_DISPLAY_NAMES };
  const present = new Set(CATEGORIES.flatMap((id) => lists[id]));
  let added = 0;
  for (const { name, category, displayName } of policy?.block || []) {
    if (present.has(name)) {
      continue;
    }
    present.add(name);
    lists[category].push(name);
    displayNames[name] = displayName || APP_DISPLAY_NAMES[name] || name;
    added += 1;
  }

  const removed = CATEGORIES.reduce((n, id) => n + BUILT_IN[id].length, 0) - (present.size - added);
  for (const id of CATEGORIES) {
    Object.freeze(lists[id]);
  }
  return Object.freeze({
    lists: Object.freeze(lists),
    all: Object.freeze([...present]),
    allSet: present,
    displayNames: Object.freeze(displayNames),
    applied: Boolean(policy),
    removed,
    added,
  });
}

let current = build(null);

/**
 * Swaps in a validated policy.
 * @param {ReturnType<typeof validatePolicy>} policy
 * @returns {{removed: number, added: number}}
 */
function applyPolicy(policy) {
  current = build(policy);
  return { removed: current.removed, added: current.added };
}

function resetPolicy() {
  current = build(null);
}

/** @returns {{meeting: string[], screen: string[], wireless: string[], browser: string[], ai: string[]}} */
function getLists() {
  return current.lists;
}

/** @returns {string[]} every blocked image name, in category order */
function getAllBlocked() {
  return current.all;
}

function isBlocked(name) {
  return current.allSet.has(String(name || "").toLowerCase());
}

function getDisplayNames() {
  return current.displayNames;
}

function getDisplayName(name) {
  return current.displayNames[name] || name;
}

function isPolicyApplied() {
  return current.applied;
}

const isAllowedRename = (t) =>
  t?.type === "renamed_blocked_app" && typeof t.original === "string" && !isBlocked(t.original);

/**
 * The agent only knows the built-in list, so a renamed copy of an app the
 * policy allows is dropped here, and safe_to_proceed is re-decided the way the
 * agent decides it: no threats and not degraded.
 * @param {object|null|undefined} status - agent status response
 * @returns {object|null|undefined} the same status when nothing was dropped
 */
function filterAgentStatus(status) {
  if (!Array.isArray(status?.threats) || !status.threats.some(isAllowedRename)) {
    return status;
  }
  const threats = status.threats.filter((t) => !isAllowedRename(t));
  return {
    ...status,
    threats,
    safe_to_proceed: threats.length === 0 && status.degraded !== true,
  };
}

module.exports = {
  CATEGORIES,
  validatePolicy,
  applyPolicy,
  resetPolicy,
  getLists,
  getAllBlocked,
  isBlocked,
  getDisplayNames,
  getDisplayName,
  isPolicyApplied,
  filterAgentStatus,
};
