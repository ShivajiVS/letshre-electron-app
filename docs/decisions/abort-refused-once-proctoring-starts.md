# Abort is refused once proctoring starts

**Decision:** `abortInterview()` releases the lockdown only before the site has called `startProctoring()`. After that it is refused and logged.

**Why:** abort exists so a failed start (no attempts left, start request refused, site down) doesn't trap the candidate on a locked screen. Once the interview is running, the same call would be a way out of the lockdown without an ending the site recorded. Ending a running interview is `interviewComplete()`, after the site has submitted.

**What it means in code:**

- `PROCTORING_START` calls `startWatchdog.markLive()`; `_abortInterview` returns early when the interview is active and live (`src/main/ipcHandlers.js`).
- The app's own ways out before the start (unavailable page after three failed loads, the 3-minute start watchdog) go through the same function; the unreachable-site path forces it, since no site is there to call anything.
- The site uses `abortInterview` from its start-failure and error pages, and falls back to `interviewComplete` + `viewDashboard` for app builds without it (`src/lib/desktopExit.js` in the site).
