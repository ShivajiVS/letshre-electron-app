// Keeps checking the machine on the pages between the security check and the
// interview (permissions, identity verification, role selection). Main is the
// authority: the step gates read this state, the page's modal only shows it.

"use strict";

const {
  IPC,
  GUARD_INTERVAL_MS,
  GUARD_CLEAR_TICKS,
  GUARD_UNVERIFIED_TICKS,
  GUARD_DOOR_CHECK_DEADLINE_MS,
} = require("../shared/constants");
const { checkProcesses, invalidateProcessCache } = require("../detector/mirrorDetector");
const { detectHDMIWindows } = require("../detector/hdmiDetector");
const { fetchAgentStatus } = require("../detector/agentClient");
const {
  FAIL,
  UNVERIFIED,
  mapHdmi,
  mapProcesses,
  mapAgent,
} = require("../detector/preflightVerdict");
const { filterAgentStatus, getDisplayName, getThreatDisplayName } = require("../shared/blocklist");
const { CODE, codeForThreat, codeForProcessCategory } = require("../shared/violationCodes");
const agentManager = require("./agentManager");
const startDetection = require("../detector/systemChecks");
const logger = require("./logger");
const { GUARDED_STEP_IDS: STAGES } = require("../shared/flowSteps");

// Backoff between attempts to bring back an agent that stopped answering.
const RECOVERY_BASE_MS = 5000;
const RECOVERY_MAX_MS = 30000;

/**
 * @typedef {{process: string, name: string, pid?: number}} IssueApp
 * @typedef {{category: string, code: string, apps: IssueApp[], closable: boolean, count?: number}} Issue
 * @typedef {{status: "clear"|"blocked"|"unverified", issues: Issue[], cleanStreak: number,
 *   unansweredStreak: number}} Machine
 */

// ─── Pure mapping and state machine

const unverified = (category, code = CODE.CHECK_UNVERIFIED) => ({
  category,
  code,
  apps: [],
  closable: false,
});

function displayIssue(display) {
  const issue = {
    category: "hdmi",
    code: display.mirrored ? CODE.MIRRORED_DISPLAY : CODE.EXTERNAL_DISPLAY,
    apps: [],
    closable: false,
  };
  if (Number.isInteger(display.count)) {
    issue.count = display.count;
  }
  return issue;
}

/** One issue per threat code. Closable only when every threat has a PID and an image name. */
function threatIssues(threats) {
  const byCode = new Map();
  for (const threat of threats) {
    const code = codeForThreat(threat);
    if (!byCode.has(code)) {
      byCode.set(code, { category: "agent", code, apps: [], closable: true });
    }
    const issue = byCode.get(code);
    const image = typeof threat?.process === "string" ? threat.process : "";
    const pid = Number.isInteger(threat?.pid) && threat.pid > 0 ? threat.pid : null;
    if (!image || !pid) {
      issue.closable = false;
    }
    if (!image) {
      continue;
    }
    const app = { process: image, name: getThreatDisplayName(threat) };
    if (pid) {
      app.pid = pid;
    }
    if (!issue.apps.some((a) => a.process === app.process && a.pid === app.pid)) {
      issue.apps.push(app);
    }
  }
  return [...byCode.values()];
}

/**
 * Sorts one tick's raw probes into violations and checks that couldn't answer,
 * with the security check's own verdict mapping and per-company blocklist.
 * @param {{proc: object|null, hdmi: object|null, agent: object|null}} probes
 * @returns {{dirty: Issue[], unanswered: Issue[], threats: object[], agentReachable: boolean}}
 */
function classifyTick({ proc, hdmi, agent }) {
  const dirty = [];
  const unanswered = [];
  const agentReachable = !!agent && !agent.error;

  // Mirrored screens read as one logical display, so the agent's panel count
  // upgrades a verified-clear display probe.
  const physical = agentReachable ? agent.physical_monitors : null;
  const display =
    hdmi && !hdmi.detected && hdmi.status === "clear" && physical > 1
      ? { ...hdmi, detected: true, status: "violation", mirrored: true, count: physical }
      : hdmi;
  const displayVerdict = mapHdmi(display);
  if (displayVerdict.status === FAIL) {
    dirty.push(displayIssue(display));
  } else if (displayVerdict.status === UNVERIFIED) {
    unanswered.push(unverified("hdmi"));
  }

  const scan = proc ? { status: proc.status, details: { processes: proc.found || [] } } : null;
  for (const v of mapProcesses(scan)) {
    if (v.status === FAIL) {
      dirty.push({
        category: v.id,
        code: codeForProcessCategory(v.id),
        apps: v.blockedApps.map((p) => ({ process: p, name: getDisplayName(p) })),
        closable: true,
      });
    } else if (v.status === UNVERIFIED) {
      unanswered.push(unverified(v.id));
    }
  }

  let threats = [];
  if (!agentReachable) {
    unanswered.push(unverified("agent", CODE.AGENT_UNREACHABLE));
  } else {
    const v = mapAgent({ alive: true, status: agent });
    if (v.status === FAIL) {
      threats = v.threats;
      dirty.push(...threatIssues(threats));
    } else if (v.status === UNVERIFIED) {
      unanswered.push(unverified("agent"));
    }
  }

  return { dirty, unanswered, threats, agentReachable };
}

/** @returns {Machine} */
const initialMachine = () => ({ status: "clear", issues: [], cleanStreak: 0, unansweredStreak: 0 });

/**
 * A violation blocks at once and clears after GUARD_CLEAR_TICKS clean ticks in
 * a row. Checks that can't answer block after GUARD_UNVERIFIED_TICKS in a row,
 * or at once on a door check.
 * @param {Machine} prev
 * @param {{dirty: Issue[], unanswered: Issue[]}} tick
 * @param {{door?: boolean}} [opts]
 * @returns {Machine}
 */
function nextState(prev, tick, { door = false } = {}) {
  const unansweredStreak = tick.unanswered.length > 0 ? prev.unansweredStreak + 1 : 0;
  if (tick.dirty.length > 0) {
    return { status: "blocked", issues: tick.dirty, cleanStreak: 0, unansweredStreak };
  }
  if (tick.unanswered.length > 0) {
    if (door || prev.status === "unverified" || unansweredStreak >= GUARD_UNVERIFIED_TICKS) {
      return { status: "unverified", issues: tick.unanswered, cleanStreak: 0, unansweredStreak };
    }
    return { ...prev, cleanStreak: 0, unansweredStreak };
  }
  const cleanStreak = prev.cleanStreak + 1;
  if (prev.status === "clear" || cleanStreak >= GUARD_CLEAR_TICKS) {
    return { status: "clear", issues: [], cleanStreak, unansweredStreak: 0 };
  }
  return { ...prev, cleanStreak, unansweredStreak: 0 };
}

// ─── Runtime

let _running = false;
/** @type {Electron.BrowserWindow|null} */
let _win = null;
let _stage = null;
let _timer = null;
let _epoch = 0;
let _tickSeq = 0;
let _appliedSeq = 0;
let _machine = initialMachine();
let _checking = false;
/** @type {Promise<object>|null} */
let _door = null;
/** @type {Promise<void>|null} */
let _scheduled = null;
let _blockedSince = null;
let _flashing = false;
let _agentDown = false;
let _recovery = { attempts: 0, nextAt: 0, pending: null };
// A practice run from the dashboard ends at the security check. Survives stop().
let _practice = false;

let _public = { status: "clear", stage: null, seq: 0, checking: false, issues: [] };

/** Resolves with `fallback` when `work` throws, rejects or runs past `ms`. */
function withDeadline(work, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const run = Promise.resolve()
    .then(work)
    .catch(() => fallback);
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/** First waits for the agent, then restarts it, each attempt further apart. */
function _recoverAgent() {
  if (_recovery.pending) {
    return _recovery.pending;
  }
  const now = Date.now();
  if (now < _recovery.nextAt) {
    return Promise.resolve(false);
  }
  const attempt = _recovery.attempts;
  _recovery.attempts += 1;
  _recovery.nextAt = now + Math.min(RECOVERY_BASE_MS * 2 ** attempt, RECOVERY_MAX_MS);
  logger.warn(`[guard] agent not answering — ${attempt === 0 ? "waiting for" : "restarting"} it`);
  const recovery = _recovery;
  const pending = Promise.resolve()
    .then(() => (attempt === 0 ? agentManager.whenAgentReady() : agentManager.restartAgent()))
    .catch((err) => {
      logger.warn("[guard] agent recovery failed:", err.message);
      return false;
    })
    .finally(() => {
      if (recovery.pending === pending) {
        recovery.pending = null;
      }
    });
  recovery.pending = pending;
  return pending;
}

const _needsAgentRecovery = () => _agentDown && _machine.unansweredStreak >= GUARD_UNVERIFIED_TICKS;

async function _probe({ recover = false } = {}) {
  invalidateProcessCache();
  const agentStatus = async () => {
    if (recover) {
      await _recoverAgent();
    }
    return filterAgentStatus(await fetchAgentStatus());
  };
  const [proc, hdmi, agent] = await Promise.all([
    withDeadline(() => checkProcesses(), GUARD_DOOR_CHECK_DEADLINE_MS, null),
    withDeadline(() => detectHDMIWindows(), GUARD_DOOR_CHECK_DEADLINE_MS, null),
    withDeadline(agentStatus, GUARD_DOOR_CHECK_DEADLINE_MS, null),
  ]);
  return { proc, hdmi, agent };
}

async function _tick({ door = false } = {}) {
  const epoch = _epoch;
  const seq = ++_tickSeq;
  const probes = await _probe({ recover: door && _needsAgentRecovery() });
  // Drop a tick that outlived the guard or lost the race to a newer one.
  if (!_running || epoch !== _epoch || seq < _appliedSeq) {
    return;
  }
  _appliedSeq = seq;
  _apply(classifyTick(probes), { door });
}

function _apply(tick, { door }) {
  if (tick.threats.length > 0) {
    startDetection.rememberThreats(tick.threats);
  }
  _agentDown = !tick.agentReachable;
  if (tick.agentReachable) {
    _recovery.attempts = 0;
    _recovery.nextAt = 0;
  }

  const from = _machine.status;
  _machine = nextState(_machine, tick, { door });
  if (_machine.status !== from) {
    _onTransition(from);
  }
  if (_needsAgentRecovery()) {
    _recoverAgent();
  }
  _publish();
}

function _onTransition(from) {
  const { status, issues } = _machine;
  const codes = [...new Set(issues.map((i) => i.code))];
  const data = { stage: _stage, status, codes };
  if (status === "clear") {
    if (_blockedSince !== null) {
      data.durationMs = Date.now() - _blockedSince;
    }
    _blockedSince = null;
    logger.info(`[guard] ${from} → clear on ${_stage} after ${data.durationMs ?? "?"}ms`);
  } else {
    _blockedSince ??= Date.now();
    logger.warn(`[guard] ${from} → ${status} on ${_stage}: ${codes.join(", ")}`);
    _flash();
  }
  startDetection.recordAuditEvent("guard", data);
}

function _flash() {
  const win = _win;
  try {
    if (!win || win.isDestroyed() || win.isFocused()) {
      return;
    }
    win.flashFrame(true);
    if (!_flashing) {
      _flashing = true;
      win.once("focus", _stopFlash);
    }
  } catch (err) {
    logger.warn("[guard] taskbar flash failed:", err.message);
  }
}

function _stopFlash() {
  const win = _win;
  if (!_flashing || !win) {
    return;
  }
  _flashing = false;
  try {
    win.removeListener("focus", _stopFlash);
    if (!win.isDestroyed()) {
      win.flashFrame(false);
    }
  } catch {
    // The window went away first.
  }
}

const _signature = (s) => JSON.stringify([s.status, s.stage, s.checking, s.issues]);

/** Bumps seq and pushes only when the page would see a different state. */
function _publish() {
  const next = {
    status: _machine.status,
    stage: _running ? _stage : null,
    checking: _checking,
    issues: _machine.issues,
  };
  if (_signature(next) === _signature(_public)) {
    return;
  }
  _public = { ...next, seq: _public.seq + 1 };
  _push();
}

function _push() {
  const win = _win;
  if (!win) {
    return;
  }
  if (win.isDestroyed()) {
    stop();
    return;
  }
  try {
    const wc = win.webContents;
    // Local pages only: the interview site never gets guard state.
    if (!String(wc.getURL()).startsWith("file:")) {
      return;
    }
    wc.send(IPC.PUSH_GUARD_STATUS, getState());
  } catch (err) {
    logger.warn("[guard] status push failed:", err.message);
  }
}

const _onPageLoad = () => _push();

const _onClosed = () => stop();

function _onDisplayChange() {
  if (_running) {
    _tick().catch((err) => logger.warn("[guard] display tick failed:", err.message));
  }
}

function _scheduledTick() {
  if (!_running || _door || _scheduled) {
    return;
  }
  if (_win?.isDestroyed()) {
    stop();
    return;
  }
  const tick = _tick()
    .catch((err) => logger.warn("[guard] tick failed:", err.message))
    .finally(() => {
      if (_scheduled === tick) {
        _scheduled = null;
      }
    });
  _scheduled = tick;
}

function _screen() {
  try {
    const { screen } = require("electron");
    return screen && typeof screen.on === "function" ? screen : null;
  } catch {
    return null;
  }
}

function _watchDisplays(on) {
  const screen = _screen();
  if (!screen) {
    return;
  }
  try {
    for (const event of ["display-added", "display-removed"]) {
      if (on) {
        screen.on(event, _onDisplayChange);
      } else {
        screen.removeListener(event, _onDisplayChange);
      }
    }
  } catch (err) {
    logger.warn("[guard] display events unavailable:", err.message);
  }
}

function _detachWindow() {
  const win = _win;
  _win = null;
  if (!win) {
    return;
  }
  try {
    win.removeListener("closed", _onClosed);
    if (!win.isDestroyed()) {
      win.webContents.removeListener("did-finish-load", _onPageLoad);
    }
  } catch {
    // The window went away first.
  }
}

// ─── API

/**
 * Starts guarding `win` at `stage`, or just moves the stage when it already
 * guards that window. The first tick runs immediately.
 * @param {Electron.BrowserWindow} win
 * @param {"permissions"|"identity"|"role"} stage
 */
function start(win, stage) {
  if (!STAGES.includes(stage) || !win || win.isDestroyed()) {
    logger.warn(`[guard] not started — no usable window or unknown stage "${stage}"`);
    return;
  }
  if (_practice) {
    logger.warn(`[guard] not started on ${stage} — this is a practice run`);
    return;
  }
  if (_running && _win === win) {
    setStage(stage);
    return;
  }
  stop();
  _running = true;
  _win = win;
  _stage = stage;
  win.once("closed", _onClosed);
  win.webContents.on("did-finish-load", _onPageLoad);
  _watchDisplays(true);
  _timer = setInterval(_scheduledTick, GUARD_INTERVAL_MS);
  logger.info(`[guard] started on ${stage}`);
  _publish();
  _scheduledTick();
}

/** @param {"permissions"|"identity"|"role"} stage */
function setStage(stage) {
  if (!_running || !STAGES.includes(stage)) {
    return;
  }
  if (stage !== _stage) {
    logger.info(`[guard] stage ${_stage} → ${stage}`);
  }
  _stage = stage;
  _publish();
}

/** @returns {"permissions"|"identity"|"role"|null} null while stopped */
function getStage() {
  return _running ? _stage : null;
}

/** Stops for good and forgets the state. Safe to call when already stopped. */
function stop() {
  if (!_running) {
    return;
  }
  if (_machine.status !== "clear") {
    logger.info(`[guard] stopped while ${_machine.status} on ${_stage}`);
  }
  _running = false;
  _epoch += 1;
  clearInterval(_timer);
  _timer = null;
  _watchDisplays(false);
  _stopFlash();
  _detachWindow();
  _stage = null;
  _machine = initialMachine();
  _checking = false;
  _door = null;
  _scheduled = null;
  _blockedSince = null;
  _agentDown = false;
  _recovery = { attempts: 0, nextAt: 0, pending: null };
  _publish();
  logger.info("[guard] stopped");
}

/** @returns {{status: string, stage: string|null, seq: number, checking: boolean, issues: Issue[]}} */
function getState() {
  return structuredClone(_public);
}

/**
 * The door check before a step and on "Check again": a fresh look within
 * GUARD_DOOR_CHECK_DEADLINE_MS. Callers during one share it.
 * @returns {Promise<ReturnType<typeof getState>>}
 */
function checkNow() {
  if (!_running) {
    return Promise.resolve(getState());
  }
  if (_door) {
    return _door;
  }
  const epoch = _epoch;
  _checking = true;
  _publish();
  const door = _tick({ door: true })
    .catch((err) => logger.warn("[guard] door check failed:", err.message))
    .then(() => {
      if (epoch === _epoch) {
        _door = null;
        _checking = false;
        _publish();
      }
      return getState();
    });
  _door = door;
  return door;
}

function isClear() {
  return _running && _machine.status === "clear";
}

function isRunning() {
  return _running;
}

/** Starts a practice run: the steps after the security check stay closed until it ends. */
function enterPractice() {
  stop();
  if (!_practice) {
    logger.info("[guard] practice run started");
  }
  _practice = true;
}

function leavePractice() {
  if (_practice) {
    logger.info("[guard] practice run ended");
  }
  _practice = false;
}

function isPractice() {
  return _practice;
}

module.exports = {
  start,
  setStage,
  getStage,
  stop,
  getState,
  checkNow,
  isClear,
  isRunning,
  enterPractice,
  leavePractice,
  isPractice,
  STAGES,
  _internal: {
    classifyTick,
    nextState,
    initialMachine,
    tick: () => _tick(),
    settle: () => Promise.all([_scheduled, _door]),
  },
};
