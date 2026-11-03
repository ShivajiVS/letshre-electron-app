# Fail closed

**Decision:** a check that errors, times out or can't answer is never "clean". It is `unverified`, and it blocks.

**Why:** a probe that fails silently is a bypass anyone can trigger: kill the agent, starve the process scan, and every check passes.

**What it means in code:**

- Security check: each probe runs under its own deadline; a missed one marks that check unverified and Continue stays disabled (`src/detector/systemChecks.js` `withDeadline`, `src/detector/preflightVerdict.js`).
- An agent whose source hash doesn't match this build is unverified, not trusted (`preflightVerdict.js`, `src/shared/agentBuild.js`).
- Flow guard: 3 unanswered ticks, or one unanswered door check, blocks the step as unverified (`src/main/flowGuard.js` `nextState`).
- Interview: 3 indeterminate display or process ticks in a row raise `check_unverified` (`trackIndeterminate` in `systemChecks.js`). The agent is judged by its scans, not by ticks (`trackAgentHealth`): unreachable for 30s, restart included, raises `agent_unreachable`; one check failing every scan for a minute, or no new scan for 45s, raises `check_unverified`. All are hard.
- The agent reports a check that fails on a busy machine as `stale`, with its last good result, for up to 2 minutes (`LAST_GOOD_MAX_AGE_S` in `agent.py`). A stale threat still blocks. A check with no recent good result stays `error`.
- Optional extras fail the other way on purpose: a failing blocklist policy falls back to the built-in lists, and telemetry is dropped. Neither can let a candidate through that the built-ins would stop.

**Cost:** a candidate with a broken agent can't take the interview until it runs. That is what Re-scan and the agent self-heal are for.
