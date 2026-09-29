// Pure mapping from raw detector output to the preflight's verdicts. Each check
// is pass, fail or unverified, and unverified blocks Continue just like fail.

"use strict";

const { getLists } = require("../shared/blocklist");
const { MINIMUM_SUPPORTED_CONTRACT_VERSION } = require("../shared/constants");
const { agentSourceMatches } = require("../shared/agentBuild");

const PASS = "pass";
const FAIL = "fail";
const UNVERIFIED = "unverified";

/** Every card the preflight renders, in display order. */
const CHECK_IDS = ["hdmi", "meeting", "screen", "wireless", "browser", "ai", "agent"];

const PROCESS_CHECK_IDS = ["meeting", "screen", "wireless", "browser", "ai"];

/**
 * @typedef {object} Verdict
 * @property {string} id            - one of CHECK_IDS
 * @property {"pass"|"fail"|"unverified"} status
 * @property {string} reasonKey     - i18n key for the card description
 * @property {object} [reasonParams]- interpolation params for reasonKey
 * @property {string[]} [blockedApps] - process names to render kill buttons for
 * @property {object[]} [threats]   - agent threat rows
 * @property {object[]} [notices]   - agent findings shown on a passing card, never blocking
 */

function verdict(id, status, reasonKey, extra = {}) {
  return { id, status, reasonKey, ...extra };
}

/**
 * An indeterminate probe also reports detected === false, so status is checked
 * first: a thrown probe must never read as "no external display".
 * @param {object|null|undefined} result
 * @returns {Verdict}
 */
function mapHdmi(result) {
  if (!result || result.status === "indeterminate") {
    return verdict("hdmi", UNVERIFIED, "preflightResults.hdmiUnverified");
  }
  if (result.detected) {
    const params = Number.isInteger(result.count) ? { reasonParams: { count: result.count } } : {};
    return result.mirrored
      ? verdict("hdmi", FAIL, "preflightResults.hdmiMirrored", params)
      : verdict("hdmi", FAIL, "preflightResults.hdmiDetected", params);
  }
  return verdict("hdmi", PASS, "preflightResults.hdmiClear");
}

/**
 * Sorts the blocked-process scan onto its cards. This lives in main, not the
 * renderer, because the gate is computed from these verdicts.
 *
 * @param {object|null|undefined} result - detectMirroring() output
 * @returns {Verdict[]} one verdict per PROCESS_CHECK_IDS entry, in order
 */
function mapProcesses(result) {
  if (!result || result.status === "indeterminate") {
    return PROCESS_CHECK_IDS.map((id) =>
      verdict(id, UNVERIFIED, "preflightResults.checkUnverified")
    );
  }

  const procs = result.details?.processes || [];
  const lists = getLists();
  const inList = (list) => procs.filter((p) => list.includes(p));
  const categorised = [lists.meeting, lists.screen, lists.browser, lists.ai];
  // Anything blocked that fits no other card is a casting or remote tool.
  const other = procs.filter((p) => !categorised.some((list) => list.includes(p)));

  const card = (id, found, runningKey, clearKey) =>
    found.length > 0
      ? verdict(id, FAIL, runningKey, { blockedApps: found })
      : verdict(id, PASS, clearKey);

  return [
    card(
      "meeting",
      inList(lists.meeting),
      "preflightResults.meetingRunning",
      "preflightResults.meetingClear"
    ),
    card(
      "screen",
      inList(lists.screen),
      "preflightResults.screenRunning",
      "preflightResults.screenClear"
    ),
    card("wireless", other, "preflightResults.wirelessRunning", "preflightResults.wirelessClear"),
    card(
      "browser",
      inList(lists.browser),
      "preflightResults.browserRunning",
      "preflightResults.browserClear"
    ),
    card("ai", inList(lists.ai), "preflightResults.aiRunning", "preflightResults.aiClear"),
  ];
}

/**
 * Not running is a fail (the agent is mandatory); anything short of a clean,
 * current, non-degraded scan is unverified.
 * @param {{alive: boolean, status: object|null, blocked?: boolean}|null|undefined} agent
 * @returns {Verdict}
 */
function mapAgent(agent) {
  if (!agent || !agent.alive) {
    return agent?.blocked
      ? verdict("agent", FAIL, "preflightResults.agentBlocked")
      : verdict("agent", FAIL, "preflightResults.agentFailedStart");
  }

  const status = agent.status;
  if (!status) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentUnverified");
  }

  const threats = status.threats || [];
  if (threats.length > 0) {
    return verdict("agent", FAIL, "preflightResults.agentThreatsDetected", {
      reasonParams: { n: threats.length },
      threats,
    });
  }

  // An older agent.exe predates fields like `degraded`, so its "safe" means less.
  if (!(status.contract_version >= MINIMUM_SUPPORTED_CONTRACT_VERSION)) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentUnverified");
  }

  // Binary doesn't match the agent.py this app shipped with — swapped, or left
  // behind by an older install. Its "no threats" is not evidence of anything.
  if (!agentSourceMatches(status.source_sha)) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentUnverified");
  }

  if (status.degraded === true) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentDegraded");
  }

  if (status.safe_to_proceed === false) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentUnverified");
  }

  const notices = Array.isArray(status.notices)
    ? status.notices.filter((n) => n && typeof n === "object")
    : [];
  return verdict("agent", PASS, "preflightResults.agentClear", notices.length ? { notices } : {});
}

/**
 * @param {{hdmi: object, mirror: object, agent: object}} raw
 * @returns {Verdict[]} one verdict per CHECK_IDS entry, in display order
 */
function buildVerdicts(raw) {
  const byId = new Map();
  byId.set("hdmi", mapHdmi(raw?.hdmi));
  for (const v of mapProcesses(raw?.mirror)) {
    byId.set(v.id, v);
  }
  byId.set("agent", mapAgent(raw?.agent));
  return CHECK_IDS.map((id) => byId.get(id));
}

/**
 * The authoritative gate: every check must have passed.
 * @param {Verdict[]} verdicts
 * @returns {boolean}
 */
function canProceed(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length !== CHECK_IDS.length) {
    return false;
  }
  return verdicts.every((v) => v && v.status === PASS);
}

module.exports = {
  PASS,
  FAIL,
  UNVERIFIED,
  CHECK_IDS,
  PROCESS_CHECK_IDS,
  mapHdmi,
  mapProcesses,
  mapAgent,
  buildVerdicts,
  canProceed,
};
