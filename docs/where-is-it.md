# Where is it

To change X, open Y. Tests that will catch a half-done change are named where they exist.

## Blocklist and detection

| To…                                              | Open                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a blocked app                                | `src/shared/appList.js` (list + `APP_DISPLAY_NAMES`). A Windows `.exe` also goes in `RENAMED_APP_BLOCKLIST` in `agent.py` (`test/agentBlocklistParity.test.js`), then `pnpm run build:agent` |
| Stop an app relaunching itself after Close       | `APP_SERVICES` / `APP_COMPANIONS` / `APP_COMPANION_SCOPES` in `src/shared/appList.js`                                                                                                        |
| Allow or block an app for one company only       | The backend's blocklist policy endpoint (`PREFLIGHT_POLICY_PATH`); rules in `src/main/blocklistPolicy.js` and `src/shared/blocklist.js`                                                      |
| Add an AI tool the agent should find             | `agent.py` (AI tool check), then `pnpm run build:agent`                                                                                                                                      |
| Trust a laptop pop-up that looks like an overlay | `OVERLAY_TRUSTED_LOCATIONS` in `agent.py`                                                                                                                                                    |
| Change how often live detection runs             | `DETECTION_INTERVAL_MS` in `src/shared/constants.js`                                                                                                                                         |
| Change how many failed checks escalate           | `INDETERMINATE_ESCALATION_THRESHOLD` in `src/shared/constants.js`                                                                                                                            |
| Change the repeat cooldown for a violation       | `VIOLATION_COOLDOWN_MS` in `src/shared/constants.js`                                                                                                                                         |
| Change what makes a violation a hard block       | `sendViolation` in `src/detector/systemChecks.js`; never-hard codes are `STRIKE_CODES` in `src/shared/violationCodes.js`                                                                     |
| Change the flow guard's cadence or streaks       | `GUARD_*` in `src/shared/constants.js`; logic in `src/main/flowGuard.js`                                                                                                                     |
| Change the security-check page's behaviour       | `src/renderer/preflightModel.js` (pure logic, tested) and `src/renderer/preflight.js` (DOM)                                                                                                  |

## Strikes and termination

| To…                                           | Open                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Change the strike limit                       | Not here. The site owns it: `VITE_AI_MAX_VIOLATIONS_ALLOWED` in the interview site                      |
| Make a code end the interview, or not         | The site's `src/lib/electronViolations.js`. On the app side, only `STRIKE_CODES` can force "never hard" |
| Change what the candidate sees on a violation | The site's `violations.electron.*` strings. The app has no violation page                               |

## Adding a violation code end to end

1. `src/shared/violationCodes.js`: add it to `CODE`, and to `STRIKE_CODES` if it must never be a hard block.
2. Raise it: pass `{ code: CODE.X }` to `sendViolation` from the check that finds it (`systemChecks.js`, `lockdownGuard.js`, `osLockdown.js`, …).
3. `contract/interview-contract.json`: add the code (`treatAs`, `neverHardBlock`, `meaning`). `test/contract.test.js` fails until you do.
4. The table in [web-contract.md](web-contract.md#codes).
5. Release the app.
6. `pnpm contract:sync <site-checkout>`, then in the site: `KEY_BY_CODE` (and `BY_KEY` if it needs new copy) in `src/lib/electronViolations.js`, strings `violations.electron.<key>.title/description` in all 19 `src/i18n/locales/<lang>/interview.json`. The site's contract test fails until the code is mapped.
7. If the site now needs the new app, raise `VITE_MIN_DESKTOP_VERSION` there.

## IPC and the site

| To…                                        | Open                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an IPC channel for a local page        | `IPC` in `src/shared/constants.js`; the hand-mirrored `IPC` object and the `ALLOWED_*` list in `preload.js`; `registerHandler`/`registerSend` with `SCOPE.LOCAL` in `src/main/ipcHandlers.js` (`test/ipcScope.test.js`) |
| Add a method the interview site may call   | Same as above with `SCOPE.INTERVIEW`, plus `EXPECTED_INTERVIEW_SCOPE_CHANNELS` in `test/ipcScope.test.js` and `electronAPI.methods` in `contract/interview-contract.json` (`test/contract.test.js`)                     |
| Pass new data to the site at start         | `lockdownForInterview` in `src/main/windowManager.js` (sessionStorage) and `contract.sessionStorage`                                                                                                                    |
| Change which origin counts as the site     | `INTERVIEW_FRONTEND_BASE_URL` in `.env`; checked in `src/main/ipcScope.js`                                                                                                                                              |
| Change the reasons the dashboard reacts to | `ABORT_INTERVIEW` handler in `src/main/ipcHandlers.js`, notes in `src/renderer/dashboard.js`                                                                                                                            |

## Lockdown

| To…                                         | Open                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Change the interview window's flags         | `_createInterviewWindow` in `src/main/windowManager.js`                                        |
| Change how drift is repaired                | `src/main/lockdownGuard.js`                                                                    |
| Block another key combination (Windows)     | The keyboard hook in `agent.py` (`lockdown_*` commands), driven by `src/main/osLockdown.js`    |
| Change the "interview never started" timing | `STALL_AFTER_MS` / `ASK_AGAIN_MS` in `src/main/startWatchdog.js`                               |
| Change the unavailable-page retry schedule  | `src/main/windowManager.js` (interview load retries), page `assets/interview-unavailable.html` |

## Strings, pages, build

| To…                                | Open                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Change a locale string             | `assets/locales/<lang>.json` (all 19; `en.json` is the source). `test/locales.test.js` and `test/localeKeyUsage.test.js` check keys |
| Ship a translated locale           | Set `reviewed: true` for it in `SUPPORTED_LOCALES` (`src/shared/constants.js`) once a translator has signed off                     |
| Change a local page                | `assets/<page>.html`, `assets/css/<page>.css`, `src/renderer/<page>.js`                                                             |
| Change a timing or URL             | `src/shared/constants.js`                                                                                                           |
| Change recording bitrate or upload | `src/main/adaptiveBitrate.js`, `src/main/screenRecorder.js`, `src/main/pendingUploads.js`                                           |
| Change the release checks          | `scripts/verifyRelease.js`, `scripts/releaseManifest.js`, `.github/workflows/build.yml`                                             |
