# The site owns enforcement

**Decision:** the app detects and reports. The interview site decides what a violation costs and when the interview ends. There is no local violation page.

**Why:** strikes, warnings, identity checks and the termination notice already live on the site, with its own limits (`VITE_AI_MAX_VIOLATIONS_ALLOWED`) and copy in 19 languages. A second enforcement path in the app disagreed with it, and a local page swapped in over the interview lost the site's state. Tuning a limit shouldn't need a desktop release.

**What it means in code:**

- `sendViolation` pushes, reports to the backend and holds until acked; it never ends anything (`src/detector/systemChecks.js`).
- `isHardBlock` is advice. The site may treat a code as harder, never softer. `STRIKE_CODES` are never hard (`src/shared/violationCodes.js`).
- Only the site's `interviewComplete()` (or the candidate confirming exit) releases the lockdown (`src/main/ipcHandlers.js`).
- A missing ack never unlocks anything. Up to 1.4.0 it did, and the first hard block left an unlocked window behind.
- The modal on the pages after the security check (`src/renderer/securityGuard.js`) is a gate before the interview, not enforcement during it.

See [../web-contract.md](../web-contract.md).
