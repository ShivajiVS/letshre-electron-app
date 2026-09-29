# Fail closed

**Decision:** a check that errors, times out or can't answer is never "clean". It is `unverified`, and it blocks.

**Why:** a probe that fails silently is a bypass anyone can trigger: kill the agent, starve the process scan, and every check passes.

**What it means in code:**

- Security check: each probe runs under its own deadline; a missed one marks that check unverified and Continue stays disabled (`src/detector/systemChecks.js` `withDeadline`, `src/detector/preflightVerdict.js`).
- An agent whose source hash doesn't match this build is unverified, not trusted (`preflightVerdict.js`, `src/shared/agentBuild.js`).
- Flow guard: 3 unanswered ticks, or one unanswered door check, blocks the step as unverified (`src/main/flowGuard.js` `nextState`).
- Interview: 3 indeterminate ticks in a row raise `agent_unreachable` or `check_unverified`, both hard (`trackIndeterminate` in `systemChecks.js`, `INDETERMINATE_ESCALATION_THRESHOLD`).
- Optional extras fail the other way on purpose: a failing blocklist policy falls back to the built-in lists, and telemetry is dropped. Neither can let a candidate through that the built-ins would stop.

**Cost:** a candidate with a broken agent can't take the interview until it runs. That is what Re-scan and the agent self-heal are for.
