# Shadow mode before enforcement

**Decision:** a new signal is measured before it costs anyone anything.

**Why:** thresholds guessed at a desk are wrong on real hardware. The laptop hotkey pop-ups that looked like overlays (fixed in 1.4.2) are the example: real machines produced what no test did.

**What it means here:** the app has no shadow switch of its own. It gets the same effect three ways:

- A new window/OS signal ships as a never-hard code the site only logs, before anyone decides it should strike. `focus_lost` and `virtual_desktop` shipped that way (`STRIKE_CODES` in `src/shared/violationCodes.js`; `logOnly` in the site's `src/lib/electronViolations.js`).
- Security-check telemetry reports verdicts and timings without names or paths, so a check's failure rate is known before it's tightened (`src/main/preflightTelemetry.js`).
- The agent's raw finding stays in the local audit log; only the code and app names are sent (`threatEvent` in `violationCodes.js`).

The site has the explicit switches (`VITE_AI_SHADOW_LABELS`, `VITE_AI_SHADOW_RULES`).
