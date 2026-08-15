/**
 * src/detector/preflightVerdict.js
 * ────────────────────────────────
 * Pure mapping from raw detector output → the preflight's verdict contract.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Detectors speak a three-state contract (clear | violation | indeterminate).
 * The live interview tick honours all three via trackIndeterminate(), but the
 * preflight used to branch only on a boolean `detected` flag, which silently
 * collapsed "I could not verify this" into "this passed". Three fail-OPEN holes
 * came out of that:
 *
 *   1. tasklist/ps failing  → detectMirroring returns indeterminate with an
 *      empty process list → all four app cards rendered green.
 *   2. the display probe throwing → hdmi.detected === false → "No external
 *      display detected."
 *   3. the agent answering ping but not scan → status === null → threats === []
 *      → "No AI tools ... detected." with a Ready badge.
 *
 * Every check now resolves to exactly one of:
 *   pass       — affirmatively verified clean
 *   fail       — affirmatively detected a problem (candidate can act on it)
 *   unverified — could not be established either way
 *
 * `unverified` blocks Proceed exactly like `fail` (fail-CLOSED), but is a
 * distinct state so the UI can say "couldn't verify, retry" instead of accusing
 * the candidate of something.
 *
 * These functions are pure and synchronous so they can be unit-tested without
 * Electron — see test/preflightVerdict.test.js.
 */

"use strict";

const {
  MEETING_APPS,
  SCREEN_SHARING_APPS,
  AI_CHEATING_APPS,
} = require("../shared/appList");

/** Verdict states. `unverified` is fail-closed — it blocks Proceed. */
const PASS = "pass";
const FAIL = "fail";
const UNVERIFIED = "unverified";

/**
 * Every card the preflight renders, in display order. The renderer builds its
 * UI from this list, so adding a check here is the only change needed to
 * surface it (plus its i18n keys).
 */
const CHECK_IDS = ["hdmi", "meeting", "screen", "wireless", "ai", "agent"];

/**
 * @typedef {object} Verdict
 * @property {string} id            - one of CHECK_IDS
 * @property {"pass"|"fail"|"unverified"} status
 * @property {string} reasonKey     - i18n key for the card description
 * @property {object} [reasonParams]- interpolation params for reasonKey
 * @property {string[]} [blockedApps] - process names to render kill buttons for
 * @property {object[]} [threats]   - agent threat rows
 */

/** Builds a verdict object, omitting empty optional fields. */
function verdict(id, status, reasonKey, extra = {}) {
  return { id, status, reasonKey, ...extra };
}

/**
 * Maps the external-display probe.
 * hdmiDetector returns { detected, status, monitors, reason }. A throw inside
 * the probe surfaces as status "indeterminate" with detected === false — which
 * must NOT be read as "no external display".
 * @param {object|null|undefined} result
 * @returns {Verdict}
 */
function mapHdmi(result) {
  if (!result || result.status === "indeterminate") {
    return verdict("hdmi", UNVERIFIED, "preflightResults.hdmiUnverified");
  }
  if (result.detected) {
    return verdict("hdmi", FAIL, "preflightResults.hdmiDetected");
  }
  return verdict("hdmi", PASS, "preflightResults.hdmiClear");
}

/**
 * Maps the blocked-process scan onto its four cards.
 *
 * Categorisation moved out of the renderer and into main: the renderer must not
 * be the component that decides whether the machine is clean, because
 * `canProceed` is now computed here and re-verified before lockdown.
 *
 * @param {object|null|undefined} result - detectMirroring() output
 * @returns {Verdict[]} exactly four verdicts: meeting, screen, wireless, ai
 */
function mapProcesses(result) {
  const ids = ["meeting", "screen", "wireless", "ai"];

  // A scan that could not complete leaves ALL FOUR cards unverified. Previously
  // this path produced an empty process list, which rendered as four passes.
  if (!result || result.status === "indeterminate") {
    return ids.map((id) => verdict(id, UNVERIFIED, "preflightResults.checkUnverified"));
  }

  const procs = result.details?.processes || [];
  const inList = (list) => procs.filter((p) => list.includes(p));

  const meeting = inList(MEETING_APPS);
  const screen = inList(SCREEN_SHARING_APPS);
  const ai = inList(AI_CHEATING_APPS);
  // Anything blocked that isn't meeting/screen/ai is a casting or remote-desktop
  // tool, which is what the "wireless" card covers.
  const other = procs.filter(
    (p) =>
      !MEETING_APPS.includes(p) &&
      !SCREEN_SHARING_APPS.includes(p) &&
      !AI_CHEATING_APPS.includes(p)
  );

  const card = (id, found, runningKey, clearKey) =>
    found.length > 0
      ? verdict(id, FAIL, runningKey, { blockedApps: found })
      : verdict(id, PASS, clearKey);

  return [
    card("meeting", meeting, "preflightResults.meetingRunning", "preflightResults.meetingClear"),
    card("screen", screen, "preflightResults.screenRunning", "preflightResults.screenClear"),
    card("wireless", other, "preflightResults.wirelessRunning", "preflightResults.wirelessClear"),
    card("ai", ai, "preflightResults.aiRunning", "preflightResults.aiClear"),
  ];
}

/**
 * Maps the security agent's deep scan.
 *
 * Three distinct failure modes that used to collapse into one another:
 *   - agent not alive          → fail (it is mandatory; Re-scan respawns it)
 *   - alive but no scan result → UNVERIFIED (was silently rendered as clean)
 *   - alive, scanned, degraded → UNVERIFIED (some of its 8 checks errored)
 *
 * @param {{alive: boolean, status: object|null}|null|undefined} agent
 * @returns {Verdict}
 */
function mapAgent(agent) {
  if (!agent || !agent.alive) {
    return verdict("agent", FAIL, "preflightResults.agentFailedStart");
  }

  const status = agent.status;
  // Alive but the scan itself did not come back (timeout / pipe error). We know
  // nothing about behavioural threats, so we must not claim the machine is clean.
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

  // The agent self-reports when some of its own checks errored (Phase D). An
  // agent build predating that field omits it, which reads as "not degraded" —
  // acceptable, because `safe_to_proceed` below still gates the verdict.
  if (status.degraded === true) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentDegraded");
  }

  // Trust the agent's own verdict when it supplies one. An older build without
  // the field leaves this undefined, which correctly skips the check.
  if (status.safe_to_proceed === false) {
    return verdict("agent", UNVERIFIED, "preflightResults.agentUnverified");
  }

  return verdict("agent", PASS, "preflightResults.agentClear");
}

/**
 * Assembles the full verdict list from one raw scan result.
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
 * The authoritative gate. Proceed is allowed only when EVERY check passed —
 * `unverified` counts against it exactly like `fail`.
 * @param {Verdict[]} verdicts
 * @returns {boolean}
 */
function canProceed(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length !== CHECK_IDS.length) {
    return false; // a malformed/short list must never open the gate
  }
  return verdicts.every((v) => v && v.status === PASS);
}

module.exports = {
  PASS,
  FAIL,
  UNVERIFIED,
  CHECK_IDS,
  mapHdmi,
  mapProcesses,
  mapAgent,
  buildVerdicts,
  canProceed,
};
