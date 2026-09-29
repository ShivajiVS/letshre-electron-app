"use strict";

// Loads systemChecks against fake probes and a fake agent manager, so the
// preflight and its gate can be driven under plain Node.

const { EventEmitter } = require("node:events");
const { expectedAgentSource } = require("../src/shared/agentBuild");

const SYSTEM_CHECKS = require.resolve("../src/detector/systemChecks");
const STUBBED = {
  hdmi: require.resolve("../src/detector/hdmiDetector"),
  mirror: require.resolve("../src/detector/mirrorDetector"),
  agentClient: require.resolve("../src/detector/agentClient"),
  agentManager: require.resolve("../src/main/agentManager"),
  screenRecorder: require.resolve("../src/main/screenRecorder"),
};
const ELECTRON = require.resolve("electron");

const CLEAN_AGENT = () => ({
  threats: [],
  safe_to_proceed: true,
  degraded: false,
  physical_monitors: 1,
  contract_version: 2,
  source_sha: expectedAgentSource() ?? undefined,
});

function defaults() {
  return {
    hdmi: async () => ({ detected: false, status: "clear", count: 1, monitors: [] }),
    processes: async () => ({ found: [], status: "clear" }),
    agentReady: async () => true,
    scan: async () => CLEAN_AGENT(),
    status: async () => CLEAN_AGENT(),
    blocked: false,
    restarts: 0,
    invalidations: 0,
    recordingOffsetMs: null,
  };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

/** @returns {{ checks: object, fake: object, screen: EventEmitter, unload: () => void }} */
function loadSystemChecks() {
  const fake = defaults();
  const screen = new EventEmitter();

  stub(STUBBED.hdmi, { detectHDMIWindows: () => fake.hdmi() });

  const checkProcesses = () => fake.processes();
  const detectMirroring = async () => {
    const r = await fake.processes();
    return r.status === "indeterminate"
      ? { detected: false, status: "indeterminate", details: { processes: [] } }
      : {
          detected: r.found.length > 0,
          status: r.found.length > 0 ? "violation" : "clear",
          details: { processes: r.found },
        };
  };
  detectMirroring.checkProcesses = checkProcesses;
  detectMirroring.invalidateProcessCache = () => {
    fake.invalidations += 1;
  };
  stub(STUBBED.mirror, detectMirroring);

  stub(STUBBED.agentClient, {
    pingAgent: async () => true,
    fetchAgentStatus: () => fake.status(),
    triggerAgentScan: () => fake.scan(),
  });
  stub(STUBBED.agentManager, {
    whenAgentReady: () => fake.agentReady(),
    isAgentReady: () => true,
    isAgentBlocked: () => fake.blocked,
    restartAgent: async () => {
      fake.restarts += 1;
      return true;
    },
  });
  stub(STUBBED.screenRecorder, { getRecordingOffsetMs: () => fake.recordingOffsetMs });
  stub(ELECTRON, { screen });

  delete require.cache[SYSTEM_CHECKS];
  const checks = require(SYSTEM_CHECKS);

  const unload = () => {
    checks.stopPreProceedMonitor();
    checks.resetState();
    delete require.cache[SYSTEM_CHECKS];
    delete require.cache[ELECTRON];
    for (const id of Object.values(STUBBED)) {
      delete require.cache[id];
    }
  };
  return { checks, fake, screen, unload };
}

function fakeWin() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

module.exports = { loadSystemChecks, fakeWin, CLEAN_AGENT };
