/**
 * agentClient.js
 * ──────────────
 * Thin HTTP client that talks to the Python security agent
 * running at http://127.0.0.1:9999
 *
 * All functions are safe to call even when the agent is down —
 * they resolve with a sensible fallback instead of throwing.
 */

const http = require("http");

const AGENT_HOST = "127.0.0.1";
const AGENT_PORT = 9999;
const TIMEOUT_MS = 2000; // max wait per request

/**
 * Make a GET request to the agent.
 * Returns parsed JSON or null on any error / timeout.
 */
function agentGet(path) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: AGENT_HOST, port: AGENT_PORT, path, timeout: TIMEOUT_MS },
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
 * Ping the agent.
 * Returns true if the agent is alive, false otherwise.
 */
async function pingAgent() {
  const res = await agentGet("/ping");
  return res !== null && res.alive === true;
}

/**
 * Fetch the latest scan result from the agent.
 * Returns the status object, or null if agent is unreachable.
 *
 * Shape: { status, timestamp, os, threats: [], safe_to_proceed, scan_count }
 */
async function fetchAgentStatus() {
  return await agentGet("/status");
}

/**
 * Trigger an immediate scan on the agent and return the result.
 * Use sparingly — the background loop already runs every 3 s.
 */
async function triggerAgentScan() {
  return await agentGet("/scan");
}

module.exports = { pingAgent, fetchAgentStatus, triggerAgentScan };
