# Troubleshooting

## Where to look first

- **App log:** `%APPDATA%\letshyre-secure-interview\secure-interview.log` on Windows (`userData/secure-interview.log` elsewhere). The main process and the agent's forwarded logs both land here. `LOG_LEVEL=debug` for more.
- **Audit log:** `getAuditLog()` from a local page, or the `[systemChecks]`, `[guard]` and `[ipc]` lines in the app log. Every violation is logged with its code, severity, count and whether it was a hard block.
- **Lockdown diagnostics:** lockdown start logs the platform, each display's size and scale, and the window's kiosk, fullscreen and always-on-top state.
- **Touchpad backup:** `%LOCALAPPDATA%\letshyre-secure-interview\touchpad-restore.json` exists only while gestures are switched off, or after a crash until the agent next starts.

## Symptoms

| Symptom                                                       | Likely cause / fix                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight blocks on "Deep Scan Agent — Required"              | `agent.exe` didn't start (AV quarantine, missing binary). Click **Re‑scan** (auto‑respawns). For dev, build it: `pnpm run build:agent`, or run `AGENT_PY=1`.        |
| Agent changes have no effect                                  | Dev/prod run `resources/agent.exe`. Rebuild with `pnpm run build:agent`, or use `AGENT_PY=1`.                                                                       |
| `dist` refuses to package: agent is stale                     | `agent.py` changed since `resources/agent.exe` was built. Run `pnpm run build:agent`.                                                                               |
| Single external display never passes                          | Any second display is a violation by design. Use a single screen.                                                                                                   |
| Violations don't reach the web app                            | Ensure the page registers `onViolation` and runs inside this client (not a normal browser), on the exact `INTERVIEW_FRONTEND_BASE_URL` origin (`ipcScope.js`).      |
| The same violation keeps arriving                             | The site isn't calling `acknowledgeViolation(id)`. Redelivery is by design until it does.                                                                           |
| White screen or "Can't reach your interview" in the interview | The interview site is unreachable or returned a 5xx; the app retries on its own. For a local build, check `.env` isn't pointing at a dev server that isn't running. |
| Candidate stuck on a locked screen, interview not starting    | The start watchdog asks after 2 minutes. If the site hit a start error it should call `abortInterview()`; check the site logs for `start-*` reasons.                      |
| Touchpad gestures still off after a crash                     | They come back the next time the agent starts. Launch the app once; the restore file above is the backup.                                                           |
| App points at no server / sign‑in fails immediately           | `.env` missing or incomplete. Both `INTERVIEW_FRONTEND_BASE_URL` and `API_BASE_URL` are required; there is no fallback.                                             |
| Blocked app shows "Reopened itself"                           | A background service or relauncher brought it back. Admins get **Close with admin rights**; others must turn off the app's auto‑start, then Rescan.                 |
| Closed app still shows as running                             | Check the log for `registered service … is not installed`: a wrong name in `APP_SERVICES` looks identical to a working one.                                         |
| Quit asks "Recording still uploading"                         | Chunks are still queued. _Finish upload_ waits up to 5 min; _Quit anyway_ resumes the upload on next launch.                                                        |
| Auto‑update "Cannot parse releases feed"                      | No published GitHub release for the configured repo; harmless in dev. Never shown to the candidate.                                                                 |
| `test/contract.test.js` fails                                 | A code or interview-scoped channel changed without `contract/interview-contract.json`, or the other way round. Update both, then `pnpm contract:sync`.              |

## Development helpers

- **Iterate on the Python agent without rebuilding:** `AGENT_PY=1 pnpm dev` spawns `python agent.py` instead of `resources/agent.exe`. `AGENT_PY_BIN` overrides the interpreter (default `python`/`python3`). Dev only.
- **DevTools:** `DEVTOOLS=true` in `.env` docks DevTools at launch and allows F12 / Ctrl+Shift+I.
- **Agent tests:** `pip install -r requirements-dev.txt`, then `python -m pytest test` (or `python -m unittest discover -s test -p "test_*.py"`). CI runs them on Windows.
- **Simulate a violation:** with `DEVTOOLS` on in an unpackaged run, `await window.electronAPI.devSimulateViolation("blocked_app")` from the interview page's console fires any code through the real pipeline (push, backend report, ack). Refused otherwise.
- **Logs:** each line in `secure-interview.log` is tagged `[run:<id>]` for the launch and `sess:<sessionId>` during an interview; audit events carry the same `runId` and `sessionId`.
