/**
 * agentClient.js
 * ──────────────
 * Client for the Python security agent.
 *
 * Phase 2: the PRIMARY transport is now the stdin/stdout pipe (sendAgentCommand
 * in agentManager) — it has no TCP dependency, so AV/firewall/port conflicts can
 * no longer silently take deep detection offline. The legacy localhost HTTP
 * channel (:9999) is kept only as a FALLBACK for the rare case the pipe is
 * unavailable.
 *
 * All functions are safe to call even when the agent is down — they resolve with
 * a sensible fallback instead of throwing.
 */

const http = require("http");

const AGENT_HOST = "127.0.0.1";
const AGENT_PORT = 9999;
const TIMEOUT_MS = 2000; // max wait for a fast request (ping / cached status)
const SCAN_TIMEOUT_MS = 12000; // a full deep scan runs all 8 checks — give it room

const { getAgentSecret, sendAgentCommand } = require("../main/agentManager");

/**
 * Make a GET request to the agent.
 * Returns parsed JSON or null on any error / timeout.
 */
function agentGet(path, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: AGENT_HOST, port: AGENT_PORT, path, timeout: timeoutMs,
        headers: { "X-Agent-Token": getAgentSecret() }
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

/**
 * Ping the agent (pipe first, HTTP fallback).
 * Returns true if the agent is alive, false otherwise.
 */
async function pingAgent() {
  const viaPipe = await sendAgentCommand("ping");
  if (viaPipe) { return viaPipe.alive === true; }
  const res = await agentGet("/ping"); // fallback
  return res !== null && res.alive === true;
}

/**
 * Fetch the latest scan result from the agent (pipe first, HTTP fallback).
 * Returns the status object, or null if agent is unreachable.
 *
 * Shape: { status, timestamp, os, threats: [], safe_to_proceed, scan_count }
 */
async function fetchAgentStatus() {
  const viaPipe = await sendAgentCommand("status");
  if (viaPipe && !viaPipe.error) { return viaPipe; }
  return await agentGet("/status"); // fallback
}

/**
 * Trigger an immediate scan on the agent (pipe first, HTTP fallback).
 * Use sparingly — the background loop already runs every 3 s.
 */
async function triggerAgentScan() {
  const viaPipe = await sendAgentCommand("scan", SCAN_TIMEOUT_MS);
  if (viaPipe && !viaPipe.error) { return viaPipe; }
  return await agentGet("/scan", SCAN_TIMEOUT_MS); // fallback
}

module.exports = { pingAgent, fetchAgentStatus, triggerAgentScan };
