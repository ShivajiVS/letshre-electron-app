// Talks to the Python agent over the stdin/stdout pipe first; the localhost
// HTTP fallback (:9999) only kicks in if the pipe is unavailable. Every
// function resolves to a safe fallback instead of throwing when the agent is down.
const http = require("http");

const { AGENT_HOST, AGENT_PORT } = require("../shared/constants");
const TIMEOUT_MS = 2000; // max wait for a fast request (ping / cached status)
const SCAN_TIMEOUT_MS = 12000; // a full deep scan runs all 8 checks — give it room

const { getAgentSecret, sendAgentCommand } = require("../main/agentManager");

function agentGet(path, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: AGENT_HOST,
        port: AGENT_PORT,
        path,
        timeout: timeoutMs,
        headers: { "X-Agent-Token": getAgentSecret() },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

async function pingAgent() {
  const viaPipe = await sendAgentCommand("ping");
  if (viaPipe) {
    return viaPipe.alive === true;
  }
  const res = await agentGet("/ping");
  return res !== null && res.alive === true;
}

async function fetchAgentStatus() {
  const viaPipe = await sendAgentCommand("status");
  if (viaPipe && !viaPipe.error) {
    return viaPipe;
  }
  return await agentGet("/status");
}

async function triggerAgentScan() {
  const viaPipe = await sendAgentCommand("scan", SCAN_TIMEOUT_MS);
  if (viaPipe && !viaPipe.error) {
    return viaPipe;
  }
  return await agentGet("/scan", SCAN_TIMEOUT_MS);
}

module.exports = { pingAgent, fetchAgentStatus, triggerAgentScan };
