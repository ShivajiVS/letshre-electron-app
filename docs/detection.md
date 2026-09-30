# Detection

What the app checks, when, and how a finding becomes a violation.

- [Detection layers](#detection-layers)
- [The security check](#the-security-check)
- [Between the security check and the interview](#between-the-security-check-and-the-interview)
- [During the interview](#during-the-interview)
- [Violation model](#violation-model)
- [Reliability rules](#reliability-rules)
- [Closing blocked apps](#closing-blocked-apps)
- [Optional security-check endpoints](#optional-security-check-endpoints)

## Detection layers

**Node tier**

| Check                        | How                                                           | File                             |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------- |
| External / extended displays | `screen.getAllDisplays()` (native, instant)                   | `src/detector/hdmiDetector.js`   |
| Blocked apps running         | `tasklist /FO CSV` (Win) / `ps` (mac), exact image-name match | `src/detector/mirrorDetector.js` |
| Blocked app just launched    | Agent `process_started` push → immediate detection tick       | `src/detector/systemChecks.js`   |

**Python agent (`agent.py`)**: behavioural checks, a process‑start watcher and a physical‑monitor count, run in parallel under a 9.5s budget:

1. Window‑title scan (Win32 / AppleScript / wmctrl)
2. Suspicious network connections (AI/cheating API domains, via `psutil` + reverse DNS, cached)
3. Loaded‑DLL / module signatures (`tasklist /M`, catches renamed binaries)
4. Browser‑automation drivers (ChromeDriver, Selenium, …)
5. Suspicious Win32 window classes
6. AI interview‑copilot tools (process name / install path / stealth cmdline flags)
7. Transparent click‑through overlays (`WS_EX_LAYERED|TRANSPARENT|TOPMOST`). Only windows visible for 5s count, so volume/brightness pop‑ups are ignored; laptop pop‑up utilities in `OVERLAY_TRUSTED_LOCATIONS` are trusted only from their install folder. Reported as medium: the first one warns, the next ends the interview.
8. Virtual audio devices (VB‑Cable, Voicemeeter, …)
9. Remote sessions, virtual machines, and blocked apps running under another name (`RENAMED_APP_BLOCKLIST`, which must equal the Windows names in `appList.js`; `test/agentBlocklistParity.test.js` checks it)
10. Virtual cameras (OBS Virtual Camera, ManyCam, Snap Camera, XSplit VCam, e2eSoft VCam, Logi Capture, AlterCam, CamTwist, mmhmm, …): DirectShow video inputs in the registry plus `Win32_PnPEntity` Camera/Image devices on Windows, `system_profiler SPCameraDataType` on macOS. Only a live one is a threat: for OBS on Windows, its `OBSVirtualCamVideo` shared memory exists; for the others (and OBS on macOS), the app that feeds it is running (`VIRTUAL_CAMERA_FEEDERS`), whose PID lets the check page offer Close. One that is only installed, like the camera OBS registers on install, comes back in `notices` and shows as a note on a passing card. The site never picks a virtual camera anyway. NVIDIA Broadcast is allowed: it filters the real webcam. The keyword lists must equal `virtualCameras` in the contract (`test/test_agent_cameras.py`). Medium, like virtual audio: the first one warns, the next ends the interview.
11. **Process‑start watcher**: diffs `psutil.pids()` every 500ms and pushes `{"type":"process_started","name","pid"}` over the pipe. During an interview a blocklisted name runs a detection tick straight away instead of waiting up to 5s; the 5s tick stays as the safety net.
12. **Physical monitor count** (`EnumDisplayDevices`): catches Windows _"Duplicate"_ mode, which the logical‑display API reports as a single screen.

The built-in blocked‑app lists (meeting, screen‑share, casting, browsers, AI tools) and their friendly names live in `src/shared/appList.js`. Everything that reads them goes through `src/shared/blocklist.js`, which applies the optional [company policy](#optional-security-check-endpoints), so detection, the check cards, the kill whitelist and the page's app names always agree.

## The security check

`preflight.html` + `src/renderer/preflight.js` (page logic in `preflightModel.js`), driven by `systemChecks.runChecksOnce()`:

- The display, process and agent probes run concurrently, each under its own deadline (`PREFLIGHT_*_DEADLINE_MS`). A missed deadline marks only that check unverified, never clean.
- Scans carry a token, so a scan the page abandoned can't overwrite a newer result.
- `preflightVerdict.js` maps raw detector output to the verdict the page shows.
- A live monitor re-reads processes and displays every 2s (`PRE_PROCEED_INTERVAL_MS`). A card only turns green again after two clean reads in a row.
- **Continue** is re-verified in main. A pass older than 60s (`PREFLIGHT_RESULT_MAX_AGE_MS`) gets a quick re-check (3s budget) instead of a full rescan.
- A hung agent is restarted; crash respawns back off.

## Between the security check and the interview

`src/main/flowGuard.js` keeps checking the machine on permissions, identity verification, role selection and the rules step. Main is the authority; the page's modal (`src/renderer/securityGuard.js`) only shows the state.

- Every 2s (`GUARD_INTERVAL_MS`) it checks processes, displays and the agent.
- States: `clear`, `blocked` (something found), `unverified` (a check didn't answer 3 ticks in a row, `GUARD_UNVERIFIED_TICKS`). A block clears after 2 clean ticks (`GUARD_CLEAR_TICKS`).
- Every forward step runs a fresh "door" check first (2.5s budget, `GUARD_DOOR_CHECK_DEADLINE_MS`). An unanswered door check counts as unverified straight away.
- The modal offers Close per app, Close all, Check again and Leave setup. The taskbar flashes when a block starts while the window isn't focused.
- A stopped agent is waited for, then restarted, each attempt further apart (5s up to 30s).

## During the interview

Live detection starts as soon as Start Interview hands off to the interview page: the first tick runs immediately, then every 5s (`DETECTION_INTERVAL_MS`), so nothing goes unchecked between the flow guard and the interview. Each `runDetectionTick` covers:

- external display and duplicate-mirror,
- blocked processes launched mid-interview,
- agent deep-scan threats (every threat code in a scan is sent, not only the first; threats sharing a code are one violation, with all their apps),
- agent reachability (anti-tamper),
- and a heartbeat to the backend every 30s.

Window and OS events (minimize, fullscreen exit, close attempt, focus loss, virtual desktop) come from the [lockdown](lockdown.md) and go through the same `sendViolation`.

## Violation model

`systemChecks.sendViolation(win, event, severity, { code, category, apps })` is the single choke point for every violation. It:

- **Tags** it with a UUID `id` and a machine‑readable `code` from `src/shared/violationCodes.js` (`suspicious_activity` when the caller gives none);
- **De‑duplicates** with a per‑event cooldown (`VIOLATION_COOLDOWN_MS`, 15s);
- **Escalates** repeat offences (`isHardBlock = severity === "high" || count >= 2`), except the codes in `STRIKE_CODES` (extra displays, focus loss, virtual desktop), which are never hard blocks: the site decides;
- **Pushes** to the web app: `webContents.send("push-violation", payload)`;
- **Reports** to the backend (`POST /interview/violation`) via a bounded FIFO queue: network errors, 5xx, 408, 429 and 401 are retried with backoff (2s doubling to 60s); any other 4xx drops that report with a warning. Unsent reports are kept encrypted in `userData/pending-violations.bin` and sent after the next launch;
- **Holds** every violation until the web app acknowledges its `id`, re‑sending it if not (see [web-contract.md](web-contract.md#acknowledgement-and-redelivery)).

For agent threats, `event` is built from the code and the app names ("AI tool detected: parakeetai-desktop"). The agent's own detail can hold file paths, window titles and IP addresses, so it only goes to the local audit log.

Payload delivered to the renderer and the backend, and the full code table: [web-contract.md](web-contract.md#violation-payload).

## Reliability rules

- **Fail‑closed, never fail‑open.** A check that errors or times out returns `indeterminate`, not "clean". During a live interview, several consecutive `indeterminate` results (`INDETERMINATE_ESCALATION_THRESHOLD`, 3) escalate to `check_unverified` or `agent_unreachable`. A transient probe failure can never be a silent bypass. See [decisions/fail-closed.md](decisions/fail-closed.md).
- **One verdict path.** All live checks run in a single `runDetectionTick` and route through one `sendViolation`, so there is no duplicate timer, race, or double‑fire.
- **Pipe‑first agent.** Electron talks to the agent over a stdin/stdout JSON pipe (no TCP port, so no AV/firewall/port conflicts). HTTP `:9999` remains only as a best‑effort fallback, and a failed bind is non‑fatal.
- **No local violation page.** Enforcement is the web app's job. See [decisions/site-owns-enforcement.md](decisions/site-owns-enforcement.md).

## Closing blocked apps

The security check and the flow guard list every blocked app they find, each with a **Close** button (`processKiller.js`). Only apps on the blocklist in force can be closed.

1. **Services first.** A vendor service that would restart the app is stopped (`APP_SERVICES`: AnyDesk, TeamViewer, Parsec, Splashtop, Chrome Remote Desktop).
2. **Relaunchers next.** Launchers/updaters that bring the app back are killed before it (`APP_COMPANIONS`, e.g. `zoomlauncher.exe`). Squirrel's shared `Update.exe` (Discord, Slack, classic Teams) is only touched inside that vendor's own install folder (`APP_COMPANION_SCOPES`); if the path can't be read it is left alone.
3. **PID by PID**, children before parents, never with `taskkill /T`. Our own process, its parents and children, and the agent are excluded.
4. **Honest outcome.** The app re‑scans (same folder scoping) and watches ~3s for a relaunch, then reports one of `closed`, `already-gone`, `respawned`, `access-denied`, `still-running`, `spawn-error`, … The page shows a matching message for each.

If an app needs administrator rights (`access-denied`, or `respawned` because of a service), the button becomes **Close with admin rights**: one UAC prompt covers all its processes and services. It is offered only to admin accounts (group SID `S-1-5-32-544`, so it works on non‑English Windows), once per app, and never during an interview. Standard users get manual instructions instead.

Agent threats with a PID (deep scan card) get Close all too.

> macOS uses `ps` + per‑PID `kill` and an admin‑password dialog for the elevated retry. It is covered by unit tests only; it has not been run on a real Mac yet.

## Optional security-check endpoints

Both are off unless their path is set in `.env` (relative to `API_BASE_URL`, must start with `/`). Both send `Authorization: Bearer <accessToken>` with a 5s timeout and never hold up the candidate.

**Blocklist policy** (`src/main/blocklistPolicy.js`): `GET <PREFLIGHT_POLICY_PATH>`, once on Start Interview; cleared on logout and on returning to the dashboard.

```json
{
  "allow": ["slack.exe", "slack.app"],
  "block": [{ "name": "examtool.exe", "category": "screen", "displayName": "Exam Tool" }]
}
```

- `allow` removes built-in entries; AI tools can't be allowed. `block` adds image names to a card: `meeting`, `screen`, `wireless`, `browser` or `ai`. `displayName` is optional.
- Names are lowercased and must match `^[\w.\- ]{1,120}$`; at most 200 entries per list. Invalid entries and OS/app process names are dropped.
- The result drives detection, the check cards, the kill whitelist and the page's app names. Unset, failing or invalid → the built-in lists.

**Scan telemetry** (`src/main/preflightTelemetry.js`): `POST <PREFLIGHT_TELEMETRY_PATH>` after each security-check scan the page keeps. No process names, paths or personal data:

```json
{
  "scanId": "m1x2y3-ab12cd",
  "capturedAt": "2026-09-24T10:00:00.000Z",
  "appVersion": "1.4.4",
  "agentVersion": "2.1.0",
  "agentSource": "0123456789ab",
  "platform": "win32",
  "arch": "x64",
  "osRelease": "10.0.26200",
  "locale": "en",
  "canProceed": false,
  "durationMs": 1830,
  "verdicts": [
    {
      "id": "browser",
      "status": "fail",
      "reasonKey": "preflightResults.browserRunning",
      "blockedCount": 1
    },
    {
      "id": "agent",
      "status": "fail",
      "reasonKey": "preflightResults.agentThreatsDetected",
      "threatTypes": ["remote_session"]
    }
  ],
  "timings": { "display": { "durationMs": 4, "outcome": "ok" } },
  "policyApplied": false
}
```

Any 2xx is success. Failures are retried up to 3 times with backoff, then dropped; at most 20 are queued in memory.
