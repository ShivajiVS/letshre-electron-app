# LetsHyre Secure Interview

A Windows/macOS **Electron desktop client** that proctors online interviews. It runs a battery of security checks **before** an interview (preflight) and **continuously during** it, then hosts the LetsHyre web interview (`interview.letshyre.com`) inside a locked‑down browser window while recording the screen. If it detects cheating vectors — external monitors, screen mirroring, meeting/recording apps, AI interview copilots (Parakeet, Cluely, Final Round AI, …), transparent overlays, virtual audio cables, browser automation — it raises a **violation** to the web app and reports it to the backend. The web app owns the warning and termination screens; there is no local violation page.

> **Status:** active — v1.4.0 (2026‑09‑19).

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Application lifecycle](#application-lifecycle)
- [Detection layers](#detection-layers)
- [Violation model](#violation-model)
- [Interview lockdown](#interview-lockdown)
- [Closing blocked apps](#closing-blocked-apps)
- [Screen recording](#screen-recording)
- [Auto-update](#auto-update)
- [Detection reliability & design principles](#detection-reliability--design-principles)
- [Web app integration (the contract)](#web-app-integration-the-contract)
- [Renderer API (`window.electronAPI`)](#renderer-api-windowelectronapi)
- [Deep link protocol](#deep-link-protocol)
- [Backend endpoints expected](#backend-endpoints-expected)
- [Getting started](#getting-started)
- [Development](#development)
- [Building & packaging](#building--packaging)
- [Configuration](#configuration)
- [Security hardening](#security-hardening)
- [Troubleshooting](#troubleshooting)
- [npm scripts reference](#npm-scripts-reference)

---

## What it does

1. The candidate **signs in** with email and password (`login.html`), or the app opens straight to the **dashboard** when a saved session is still valid. A `letshyre://` [deep link](#deep-link-protocol) carrying tokens is also supported.
2. From the dashboard, **Take interview** starts the flow: **language selection** (only shown when more than one language is available) → **security check** (`preflight.html`) → **permissions** (camera/mic/screen) → **identity verification** (photo + voice sample) → **role selection**.
3. The security check blocks the candidate until every check is green: no external displays, no meeting/recording/casting apps, no AI copilot tools, and the deep‑scan agent is running. Blocked apps can be closed from the page itself.
4. After role selection, the window enters **[lockdown](#interview-lockdown)** and loads the interview web app, which starts the **[screen recording](#screen-recording)**.
5. During the interview, detection runs on a fixed cadence. Any finding is pushed to the web app as a **violation** and reported to the backend.
6. When the interview ends, the web app signals completion, the lockdown is lifted and the recording finishes uploading.

## Architecture

```
                    letshyre://…?ac=<token>   (deep link)
                                │
                 ┌──────────────▼───────────────────────────────┐
                 │            ELECTRON MAIN PROCESS              │
                 │                                               │
   main.js ─────▶│ src/main/index.js  (single instance, proto)  │
                 │ src/main/app.js     (lifecycle / onReady)     │
                 │ src/main/windowManager.js (lockdown, CSP)     │
                 │ src/main/ipcHandlers.js   (all ipcMain)       │
                 │ src/main/agentManager.js  (spawn + pipe)      │
                 │ src/detector/systemChecks.js (engine)         │
                 │   ├─ hdmiDetector.js   (Electron screen API)  │
                 │   └─ mirrorDetector.js (process scan)         │
                 └───────┬───────────────────────────┬──────────┘
                         │ preload.js (contextBridge) │ stdin/stdout pipe
                         ▼                            ▼
              ┌──────────────────────┐     ┌────────────────────────┐
              │   RENDERER (window)  │     │  PYTHON AGENT (agent.py)│
              │  local pages (file://│     │  8 behavioural checks   │
              │   login → preflight) │     │  primary: stdio pipe    │
              │  interview web app   │     │  secondary: HTTP :9999  │
              └──────────────────────┘     └────────────────────────┘
              + hidden recorder window (screen/mic → chunked upload)
```

Two cooperating detection tiers:

- **Node tier** (main process) — displays and running processes, using native OS APIs.
- **Python agent** (`agent.py`, shipped as `agent.exe`) — _behavioural_ deep checks that Node cannot do cheaply: network fingerprinting, loaded‑DLL signatures, window titles/classes, transparent overlays, virtual audio devices, browser‑automation drivers, and a physical‑monitor count.

## Tech stack

| Area                   | Choice                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| Desktop shell          | **Electron 43** (`contextIsolation`, `sandbox`, no `nodeIntegration`)          |
| Main/renderer language | Node.js **20+** (CommonJS)                                                     |
| Deep‑scan agent        | **Python 3.12** + `psutil`, bundled to a single binary with **PyInstaller**    |
| UI                     | Static HTML + hand‑authored CSS on one shared design system; self‑hosted fonts |
| i18n                   | 19 JSON locale bundles, runtime switcher                                       |
| Tests                  | Node's built‑in test runner (`node --test`)                                    |
| Packaging              | **electron-builder 26** (NSIS installer on Windows, DMG on macOS)              |
| Auto‑update            | `electron-updater` (GitHub releases)                                           |
| Lint/format            | ESLint 8 + Prettier 3                                                          |

## Repository layout

```
.
├── main.js                     # entry shim → src/main/index.js
├── agent.py                    # Python deep-scan agent (source of resources/agent.exe)
├── preload.js                  # contextBridge: exposes window.electronAPI to all pages
├── preload-recorder.js         # minimal contextBridge for the hidden recorder window
├── scripts/build_agent.py      # PyInstaller build → resources/agent.exe
├── scripts/check-env.js        # beforePack hook: refuses to package a dev .env
│
├── src/
│   ├── main/                   # Electron main process
│   │   ├── index.js            # single-instance lock, protocol registration
│   │   ├── app.js              # app lifecycle (onReady, updater, screen capture)
│   │   ├── windowManager.js    # window creation, page navigation, CSP, interview load retries
│   │   ├── lockdownGuard.js    # applies and holds the interview lockdown for the whole session
│   │   ├── ipcHandlers.js      # the only file that registers ipcMain channels
│   │   ├── ipcScope.js         # which caller (local pages vs interview site) each channel trusts
│   │   ├── agentManager.js     # spawn agent, stdin/stdout pipe, ensureAgent()
│   │   ├── authManager.js      # login against the LetsHyre API; tokens live main-process-only
│   │   ├── protocolHandler.js  # letshyre:// parsing → interview URL + token
│   │   ├── processKiller.js    # PID-accurate force-kill of blocked apps (services, relaunchers, elevation)
│   │   ├── processTable.js     # pure process-table parsing/matching used by processKiller
│   │   ├── screenRecorder.js   # hidden recorder window + chunked upload pipeline
│   │   ├── pendingUploads.js   # encrypted on-disk store for chunks not yet confirmed by the backend
│   │   ├── spillKey.js         # key for that store, sealed by the OS keystore
│   │   ├── adaptiveBitrate.js  # lowers the recording bitrate while uploads fall behind
│   │   ├── localeManager.js    # resolves/persists candidate UI language
│   │   ├── updater.js          # auto-update orchestration (electron-updater)
│   │   ├── appState.js         # quitting flag
│   │   └── logger.js           # file logger (userData/secure-interview.log)
│   │
│   ├── detector/               # detection logic (runs in main process)
│   │   ├── systemChecks.js     # detection ENGINE: preflight + live tick + violations
│   │   ├── hdmiDetector.js     # external-display detection (Electron screen API)
│   │   ├── mirrorDetector.js   # blocked-process scan (tasklist CSV / ps)
│   │   ├── preflightVerdict.js # maps raw detector output → preflight verdict contract
│   │   └── agentClient.js      # talks to the Python agent (pipe-first, HTTP fallback)
│   │
│   ├── renderer/               # page controllers (sandboxed renderer)
│   │   ├── preflight.js        # preflight screen controller
│   │   ├── login.js            # login screen controller
│   │   ├── dashboard.js        # candidate dashboard controller
│   │   ├── role-selection.js   # role-selection step state machine
│   │   ├── identity-verification.js  # identity-verification screen controller
│   │   ├── permissions.js      # OS permissions screen controller
│   │   ├── language-selection.js # pick the interview language before the security check
│   │   ├── recorder.js         # runs inside the hidden recorder window
│   │   ├── updateCard.js       # auto-update card, loaded by every local page
│   │   ├── rendererUtils.js    # small helpers shared by the page controllers
│   │   └── languageSwitcher.js # keyboard-accessible language dropdown widget
│   │
│   └── shared/
│       ├── constants.js        # single source of truth: ports, URLs, IPC names, timings
│       └── appList.js          # blocked app lists + friendly display names
│
├── assets/                     # static UI (HTML/CSS/icons/locales) loaded as file://
│   ├── login.html
│   ├── dashboard.html
│   ├── language-selection.html
│   ├── preflight.html          # security check (loads src/renderer/preflight.js)
│   ├── permissions.html
│   ├── identity-verification.html
│   ├── role-selection.html
│   ├── how-it-works.html
│   ├── interview-unavailable.html # shown, still locked, while the interview site can't be reached
│   ├── recorder.html           # hidden recorder window
│   ├── css/                    # base.css + components.css (shared design system), update-card.css, per-page sheets
│   ├── fonts/                  # self-hosted Inter + Noto subsets for non-Latin scripts
│   ├── js/i18n.js              # locale loading/translation helper
│   └── locales/                # per-language JSON translation bundles (19 languages)
│
├── test/                       # node:test suites (run with `pnpm test`)
├── .env.example                # interview/API hosts + DevTools toggle (copy to .env)
└── resources/agent.exe         # built agent binary (gitignored — rebuild before packaging)
```

## Application lifecycle

```
launch ─▶ onReady (src/main/app.js)
   ├─ logger.init, authManager.init       # restore the saved session (OS keystore)
   ├─ pendingUploads.init                 # open the encrypted recording store, purge >7-day-old sessions
   ├─ authManager.verifySession()
   ├─ registerIpcHandlers()
   ├─ applyArgvDeepLink()                 # Windows: read tokens from argv
   ├─ createWindow() → dashboard.html (valid session) | login.html
   ├─ updater.init()                      # check GitHub releases, then every 6h
   └─ resumePendingUploads()              # finish a recording a previous quit/crash interrupted
            │  dashboard: Take interview
            ▼
   prewarmAgent()                         # agent boots while the candidate picks a language
   language-selection.html (if >1 language) → preflight.html
            │
   SECURITY CHECK (gate)
   ├─ runPreflight → runChecksOnce()      # hdmi + processes + agent deep scan + physical monitors
   ├─ ensureAgent()                       # respawn agent if it died (self-heal on re-scan)
   ├─ close blocked apps from the page    # see "Closing blocked apps"
   └─ pre-proceed monitor (every 2s)      # keeps Proceed button state live
            │  Proceed (main re-verifies the scan passed and is fresh)
            ▼
   permissions.html → identity-verification.html → role-selection.html
            │  Start (main re-verifies a scan passed this session)
            ▼
   LOCKDOWN (windowManager.lockdownForInterview → lockdownGuard)
   ├─ kiosk + fullscreen + always-on-top, no minimize/maximize/resize/move
   ├─ held for the whole session (re-applied on drift, 1s watchdog)
   ├─ navigation guardrails (only interview origin + file://)
   └─ load interview web app (tokens, photo, role, locale via sessionStorage)
            │
   LIVE MONITOR (systemChecks.start → runDetectionTick every 5s)
   ├─ external display / duplicate-mirror
   ├─ blocked processes launched mid-interview
   ├─ agent deep-scan threats
   ├─ agent reachability (anti-tamper)
   └─ heartbeat to backend (every 30s)
   RECORDING (web app calls startProctoring; chunks upload while recording)
            │  web app signals interviewComplete
            ▼
   END (stop detection, stop agent, lift lockdown; recording stops on stopProctoring)
```

## Detection layers

**Node tier**

| Check                        | How                                                           | File                             |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------- |
| External / extended displays | `screen.getAllDisplays()` (native, instant)                   | `src/detector/hdmiDetector.js`   |
| Blocked apps running         | `tasklist /FO CSV` (Win) / `ps` (mac), exact image-name match | `src/detector/mirrorDetector.js` |

**Python agent (`agent.py`)** — eight behavioural checks plus a physical‑monitor count:

1. Window‑title scan (Win32 / AppleScript / wmctrl)
2. Suspicious network connections (AI/cheating API domains, via `psutil` + reverse DNS)
3. Loaded‑DLL / module signatures (`tasklist /M`, catches renamed binaries)
4. Browser‑automation drivers (ChromeDriver, Selenium, …)
5. Suspicious Win32 window classes
6. AI interview‑copilot tools (process name / install path / stealth cmdline flags)
7. Transparent click‑through overlays (`WS_EX_LAYERED|TRANSPARENT|TOPMOST`). Only windows visible for 5s count, so volume/brightness pop‑ups are ignored; laptop pop‑up utilities in `OVERLAY_TRUSTED_LOCATIONS` are trusted only from their install folder. Reported as medium: the first one warns, the next ends the interview.
8. Virtual audio devices (VB‑Cable, Voicemeeter, …)
9. **Physical monitor count** (`EnumDisplayDevices`) — catches Windows _“Duplicate”_ mode, which the logical‑display API reports as a single screen.

The blocked‑app lists (meeting, screen‑share, casting, browsers, AI tools) and their friendly names live in one place: `src/shared/appList.js`.

## Violation model

`systemChecks.sendViolation(win, event, severity)` is the single choke point for every violation. It:

- **De‑duplicates** with a per‑event cooldown (`VIOLATION_COOLDOWN_MS`, 15s);
- **Escalates** repeat offences (`isHardBlock = severity === "high" || count >= 2`);
- **Pushes** to the web app: `webContents.send("push-violation", payload)`;
- **Reports** to the backend (`POST /interview/violation`) via a bounded FIFO retry queue;
- **Holds** each hard block until the web app acknowledges it, re‑sending it if not ([see below](#detection-reliability--design-principles)).

Payload delivered to the renderer / backend:

```jsonc
{
  "event": "Blocked application running during interview: Google Chrome",
  "severity": "high", // "high" | "medium"
  "count": 1, // times this event has fired this session
  "isHardBlock": true, // high severity, or count >= 2
  "source": "electron",
  "timestamp": "2026-06-19T13:44:04.849Z",
}
```

## Interview lockdown

`lockdownGuard.js` applies the lockdown when the interview loads and **holds it for the whole session**. It used to be set once, so a fullscreen transition dropping always‑on‑top, Win+Down or a taskbar click left the window unlocked for the rest of the interview.

- **Locked state:** kiosk + fullscreen + always‑on‑top (`screen-saver` level); not minimizable, maximizable, resizable or movable.
- **Held:** the lock is re‑applied on minimize, fullscreen exit, always‑on‑top loss, maximize/restore and focus loss, with a 1s watchdog as a backstop.
- **Reported:** a minimize attempt is a `high` violation, a fullscreen exit a `medium` one. An always‑on‑top drop is repaired silently (Windows causes it on its own).
- **Keys:** F11 is blocked in‑window. Alt+F4 is blocked in‑window; at OS level it is reported as a `high` violation and the app quits.
- **Keyboard lock:** each time the interview page enters fullscreen, Electron calls `navigator.keyboard.lock()` so Alt+Tab, the Windows key and Win+Tab go to the page instead of Windows. The interview site gets the `fullscreen` and `keyboardLock` permissions; every other origin is refused. Ctrl+Alt+Del can never be captured.
- **Page won't load:** if the interview site is unreachable or answers with a 5xx, the window shows `interview-unavailable.html` ("Can't reach your interview", with **Try again**) and retries after 3s, 5s, 10s, 20s, then every 30s. The lockdown stays on throughout, and the session data is injected only into a page that actually loaded.
- **Released** only by `interviewComplete()` or the candidate confirming the exit dialog. Nothing else unlocks the window, including an unacknowledged violation.

## Closing blocked apps

The security check lists every blocked app it finds, each with a **Close** button (`processKiller.js`). Only apps on the blocklist in `src/shared/appList.js` can be closed.

1. **Services first.** A vendor service that would restart the app is stopped (`APP_SERVICES`: AnyDesk, TeamViewer, Parsec, Splashtop, Chrome Remote Desktop).
2. **Relaunchers next.** Launchers/updaters that bring the app back are killed before it (`APP_COMPANIONS`, e.g. `zoomlauncher.exe`). Squirrel's shared `Update.exe` (Discord, Slack, classic Teams) is only touched inside that vendor's own install folder (`APP_COMPANION_SCOPES`); if the path can't be read it is left alone.
3. **PID by PID**, children before parents, never with `taskkill /T`. Our own process, its parents and children, and the agent are excluded.
4. **Honest outcome.** The app re‑scans (same folder scoping) and watches ~3s for a relaunch, then reports one of `closed`, `already-gone`, `respawned`, `access-denied`, `still-running`, `spawn-error`, … The page shows a matching message for each.

If an app needs administrator rights (`access-denied`, or `respawned` because of a service), the button becomes **Close with admin rights**: one UAC prompt covers all its processes and services. It is offered only to admin accounts (group SID `S-1-5-32-544`, so it works on non‑English Windows), once per app, and never during an interview. Standard users get manual instructions instead.

> macOS uses `ps` + per‑PID `kill` and an admin‑password dialog for the elevated retry. It is covered by unit tests only; it has not been run on a real Mac yet.

## Screen recording

The web app starts and stops recording (`startProctoring()` / `stopProctoring()`). A hidden recorder window (`recorder.html`) captures the screen and mic, and `screenRecorder.js` uploads it **while the interview runs**:

- **Pipeline:** `/start` → upload id, `/chunk` × N during the interview (2 in parallel, retried), `/complete` only once nothing is left queued, then `/status` polling. Registration is retried during the interview rather than after it.
- **Durable:** every chunk is written to `userData/pending-uploads/` **encrypted (AES‑256‑GCM)** before it is queued, and deleted only once the backend confirms it. The key is sealed by the OS keystore; without one it stays in memory, so chunks remain unreadable but can't resume after a restart. Sessions older than 7 days are purged.
- **Adaptive:** the bitrate steps down (1 Mbps → 750 kbps → 500 kbps) while uploads fall behind, and back up once they keep pace.
- **Resumable:** uploads resume when the network returns, and anything left over is finished on the next launch (when the saved session is still valid).
- **Quitting mid‑upload** asks _Finish upload_ (waits up to 5 min) or _Quit anyway_ (resumes next launch).

Recording failures never block the interview; they are reported to the web app via `onProctoringError` (see [below](#web-app-integration-the-contract)).

## Auto-update

`updater.js` uses `electron-updater` against GitHub releases. It checks at launch and every 6 hours (retrying sooner, up to 3 times, after a failure), **downloads new versions automatically in the background**, and installs them the next time the app is closed. Nothing is checked, downloaded or installed while an interview is active.

Progress is shown by a floating card (`src/renderer/updateCard.js` + `assets/css/update-card.css`) on **every local page**: sign‑in, dashboard, language and role selection, how it works, permissions, identity verification and the security check. It is not shown during the interview: that runs on the interview site, which doesn't load the card and can't reach the update channels. Each page pulls the current state on load, so an update staged between pages still appears.

| Card             | Shows                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Update available | Version, "Downloading in the background (X MB)…", optional _What's new_                                                              |
| Downloading      | Progress bar, percentage, MB transferred                                                                                             |
| Update ready     | _Update now_ (closes the app and installs; it does **not** relaunch — the candidate reopens from their interview link) and _Dismiss_ |

Update‑check failures are logged only; the candidate never sees them.

## Detection reliability & design principles

The detection layer follows three rules that make it predictable:

- **Fail‑closed, never fail‑open.** A check that errors or times out returns `indeterminate`, not “clean”. During a live interview, several consecutive `indeterminate` results (`INDETERMINATE_ESCALATION_THRESHOLD`) escalate to a violation — a transient probe failure can never be a silent bypass.
- **One verdict path.** All live checks run in a single `runDetectionTick` and route through one `sendViolation`, so there is no duplicate timer, race, or double‑fire.
- **Pipe‑first agent.** Electron talks to the agent over a stdin/stdout JSON pipe (no TCP port → immune to AV/firewall/port conflicts). HTTP `:9999` remains only as a best‑effort fallback, and a failed bind is non‑fatal.

**Unacknowledged hard blocks.** Enforcement is the web app’s job: it shows the warning and termination screens and decides when to end the session. There is **no local violation page**.

A hard block the web app doesn't acknowledge was probably missed (page still loading, reloading or down). Electron sends it again after `HARD_BLOCK_GRACE_MS` (8s) and again on every later page load, marked `redelivered: true`. It never lifts the lockdown or stops detection because of a missing ack.

> Until 1.4.0 a missing ack made Electron unlock the window and stop detection 8s later. The web app never sent acks, so the first hard block of any interview left a normal window behind. That was the "minimize / maximize / Alt+Tab work in the installed app" report.

## Web app integration (the contract)

The interview web app (`interview.letshyre.com`) runs inside this Electron window, so `window.electronAPI` is available to it. The integration is:

1. **Receive** violations and route hard vs soft.
2. **Acknowledge** every violation so Electron knows the page received it. An unacknowledged hard block is sent again.
3. **Signal completion** when the interview ends or you decide to terminate.

```js
// useElectronViolation.js (web app)
import { useEffect } from "react";

export function useElectronViolation({ onHardBlock, onSoftBlock }) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onViolation) return; // running in a plain browser

    api.onViolation((payload) => {
      // 1) Always ack FIRST (before any modal guard) so liveness is signalled
      //    even while a warning is already open — this keeps Electron from
      //    overriding your warning flow.
      api.acknowledgeViolation?.();

      // 2) Route to your handlers. payload.event drives your title/description.
      if (payload.isHardBlock) onHardBlock?.(payload);
      else onSoftBlock?.(payload);
    });

    return () => api.removeViolationListener?.();
  }, [onHardBlock, onSoftBlock]);
}
```

When your app decides the session is over (normal finish, or terminate after N violations):

```js
window.electronAPI.interviewComplete("terminated"); // "completed" | "auto-submitted" | "terminated" | "expired"
```

> ⚠️ If the web app doesn't call `acknowledgeViolation()`, every hard block is sent to it twice (and again on each page load). The lockdown is unaffected either way.

When the scorecard's "View Dashboard" button is pressed (still on the interview origin — `interviewComplete` lifted lockdown but did not navigate away):

```js
window.electronAPI.viewDashboard?.();
```

**Recording failures.** Screen/mic recording runs independently of the violation pipeline above — it can fail (no screen source, blocked getUserMedia, upload session never established) without the interview itself being blocked. Electron does not stop the session on a recording failure; it is a policy decision left to the web app, which is why listening for it is required, not optional:

```js
window.electronAPI.onProctoringError?.(({ error }) => {
  // Recording is not being captured. Decide what this means for the session —
  // e.g. flag it for manual review, warn the candidate, or show the error.
});
```

If the web app never registers this listener, a candidate can complete an entire interview with zero recorded footage and no one — candidate, interviewer, or backend — is told.

**sessionStorage handoff.** Before the interview SPA's first render, Electron injects the following keys into its `sessionStorage` (see `windowManager.js#lockdownForInterview`):

| Key               | Meaning                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ac` / `rc`       | Access / refresh token, when a session is available                                                                                                                                                        |
| `candidate_photo` | Base64 data URL of the live photo captured during identity verification                                                                                                                                    |
| `role_selection`  | JSON-encoded `{ is_custom_role, selected_role?, manual_skills? }`                                                                                                                                          |
| `locale`          | The candidate's chosen UI language (locale code, e.g. `"hi"`) from the desktop shell's language switcher — secondary channel, see the `lang` query param below, which is race-free and should be preferred |

The `lang` query param on the interview URL (see [Deep link protocol](#deep-link-protocol)) carries the same value and is available before the SPA's first script runs, so prefer reading it over `sessionStorage.locale` at boot — `sessionStorage` is written on Electron's `dom-ready`, which can fire after a module-script SPA has already started.

## Renderer API (`window.electronAPI`)

Exposed by `preload.js` via `contextBridge` (only whitelisted channels). Safe to call in a plain browser — methods no‑op if `electronAPI` is absent. The same API is exposed to the local pages and the interview site, but main enforces who may call what (`ipcScope.js`): the interview site can only use the violation, completion, dashboard and proctoring channels.

| Method                                                                                              | Purpose                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `runPreflight()`                                                                                    | Run all preflight scans; resolves with `{ hdmi, mirror, agent }`                                                             |
| `onPreflightProgress(cb)` / `removePreflightProgressListener()`                                     | Per‑step streaming progress                                                                                                  |
| `onPreProceedStatus(cb)` / `removePreProceedStatusListener()`                                       | Live blocked‑app status on the success screen                                                                                |
| `proceedToInterview()`                                                                              | Enter lockdown and load the interview                                                                                        |
| `killProcess(name)` / `killAllProcesses(names)`                                                     | Force‑close a blocked app (whitelisted); see [Closing blocked apps](#closing-blocked-apps)                                   |
| `canElevate()` / `killProcessElevated(name)`                                                        | Whether the user is an admin; one‑shot elevated retry (refused during an interview)                                          |
| `startProctoring(meta)` / `stopProctoring()` / `onProctoringStarted(cb)`                            | Start/stop the screen recording (interview site)                                                                             |
| `onViolation(cb)` / `removeViolationListener()`                                                     | Receive violations during the interview                                                                                      |
| `onProctoringError(cb)`                                                                             | Recording failed (no screen source, upload session lost, etc.) — see [Recording failures](#web-app-integration-the-contract) |
| `acknowledgeViolation()`                                                                            | Confirm receipt; stops the hard block being sent again                                                                       |
| `interviewComplete(reason)`                                                                         | End the session; lifts lockdown                                                                                              |
| `viewDashboard()`                                                                                   | Scorecard "View Dashboard" button; leaves the interview flow for the dashboard                                               |
| `recheckSystem()` / `minimizeWindow()` / `quitApp()`                                                | Preflight UX controls                                                                                                        |
| `retryInterview()`                                                                                  | Reload the interview from the "Can't reach your interview" page                                                              |
| `getAppList()` / `getAuditLog()`                                                                    | Blocked‑app lists; in‑memory audit log                                                                                       |
| `onUpdateAvailable` / `onUpdateProgress` / `onUpdateDownloaded` / `onUpdateError` / `onUpdateState` | Auto‑updater events (used by `updateCard.js`)                                                                                |
| `getUpdateState()` / `installUpdate()` / `getAppVersion()`                                          | Current updater snapshot; quit and install; running version                                                                  |
| `login` / `logout` / `getAuthUser` / `getCandidateProfile`                                          | Sign‑in and dashboard                                                                                                        |
| `startInterview` / `load…Page` / `submitRole` / `submitFaceVerification` / `submitVoiceSample`      | Local page flow from the dashboard to the interview                                                                          |
| `getLocale` / `setLocale` / `getTranslations` / `onLocaleChanged`                                   | UI language                                                                                                                  |

## Deep link protocol

Registered scheme: **`letshyre://`**

```
letshyre://start?ac=<accessToken>&rc=<refreshToken>
```

`ac` (access) and `rc` (refresh) are parsed in `src/main/protocolHandler.js`, used to build the interview URL and to authenticate backend calls. A protocol activation **during** an active interview is treated as a high‑severity violation (possible session swap).

The interview URL also carries the candidate's chosen language as `lang` (locale code, e.g. `te`), attached on every read rather than baked in at build time — the language-selection page runs after the URL is first assembled, so the final choice isn't known yet at that point:

```
https://interview.letshyre.com/?ac=<accessToken>&rc=<refreshToken>&lang=<localeCode>
```

`lang` is gated the same way the rest of the app's locale surface is: packaged builds only ever emit a certified (`reviewed: true`) locale, so it stays `en` there until a translation is certified — all 19 codes appear in dev/QA builds.

## Backend endpoints expected

The client calls these on `API_BASE_URL` (from `.env`, no default) with `Authorization: Bearer <accessToken>` (except login/refresh):

| Endpoint                                                                          | When                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /user/v1/login/` · `POST /user/v1/login_refresh/` · `POST /user/v1/logout/` | Sign‑in, token refresh, sign‑out                                                            |
| `GET /user/v1/candidate_profile/`                                                 | Dashboard; also verifies the saved session at launch                                        |
| `POST /user/v1/candidate/interview/face_verification/`                            | Identity verification photo                                                                 |
| `POST /user/v1/candidate/interview/voice_sample/`                                 | Identity verification voice sample                                                          |
| `POST /user/v1/candidate_resume_ai/skills_for_role/`                              | Role selection                                                                              |
| `POST /user/v1/candidate_interview/video_upload/start/`                           | Register a recording upload                                                                 |
| `POST /user/v1/candidate_interview/video_upload/chunk/`                           | Each recording chunk, during the interview                                                  |
| `POST /user/v1/candidate_interview/video_upload/complete/`                        | After the last chunk is confirmed                                                           |
| `GET /user/v1/candidate_interview/video_upload/status/<uploadId>/`                | Poll until the backend has merged the video                                                 |
| `POST /interview/heartbeat`                                                       | Every 30s during the interview — `{ timestamp }`                                            |
| `POST /interview/violation`                                                       | On every violation (retried) — `{ event, severity, count, isHardBlock, source, timestamp }` |

> **Required for enforcement:** `POST /interview/violation` must be implemented server‑side to record/flag/terminate sessions. Until it exists, violation reports are queued and retried client‑side.

## Getting started

### Prerequisites

- **Node.js ≥ 20** and **pnpm ≥ 10**
- **Python 3.12** with `psutil` (and `pyinstaller` to build the agent binary):
  ```bash
  pip install psutil pyinstaller
  ```

### Install

```bash
pnpm install
cp .env.example .env   # then fill in INTERVIEW_FRONTEND_BASE_URL and API_BASE_URL
```

Both hosts are required and have **no built‑in fallback**. In dev `.env` is read from the repo root; a packaged build reads it from beside the executable, where the release workflow writes it from the `INTERVIEW_FRONTEND_BASE_URL` / `API_BASE_URL` repository variables (the build fails if either is missing). Real environment variables win over `.env`.

### Run (development)

```bash
pnpm run dev      # launches Electron with file watching (nodemon)
# or
pnpm start        # plain electron .
```

> In dev and production the app runs the **bundled** `resources/agent.exe`, not `agent.py`. To iterate on the agent without rebuilding, set `AGENT_PY=1` (see below).

## Development

- **Iterate on the Python agent without rebuilding** — run the source directly:
  ```bash
  AGENT_PY=1 pnpm start        # spawns `python agent.py` instead of resources/agent.exe
  ```
  (`AGENT_PY_BIN` overrides the interpreter, default `python`/`python3`. Dev only.)
- **Tests** — `pnpm test` (Node's built‑in runner, `test/*.test.js`).
- **Lint / format** — `pnpm run lint` / `pnpm run format`.
- **DevTools** — `DEVTOOLS=true` in `.env` docks DevTools at launch and allows F12 / Ctrl+Shift+I.
- **Logs** — the main process and forwarded agent logs are written to
  `…/AppData/Roaming/letshyre-secure-interview/secure-interview.log` (Windows).

## Building & packaging

```bash
pnpm run build:agent    # PyInstaller → resources/agent.exe   (run when agent.py changes)
pnpm run build:full     # build:agent + electron-builder, for this machine
pnpm run dist           # package for this machine
pnpm run dist:win       # package for Windows
pnpm run dist:mac       # package for macOS
```

Output goes to `release/` (NSIS installer on Windows, DMG on macOS). The agent binary is per-platform and PyInstaller cannot cross-compile, so `dist:mac` needs a Mac to have produced `resources/agent`.

> **`.env` is checked before every package** (`scripts/check-env.js`, an electron-builder `beforePack` hook, so CI's direct `electron-builder` call is covered too). Both hosts must be set, use https and not point at `localhost`, loopback or `.local`. For a local test build against a dev server, set `ALLOW_DEV_ENV=1`.

> **`resources/agent.exe` is gitignored** — it is a build artifact rebuilt from `agent.py`. Always run `build:agent` (or `build:full`) before packaging so the bundled binary matches the current `agent.py`. The `dist` scripts refuse to package when it does not, comparing the source hash recorded in `resources/agent.build.json`.

### Releasing

macOS builds run on manual workflow dispatch only. The jobs are wired up, but no dmg has been produced or installed yet, and without an Apple Developer ID certificate the build is unsigned and Gatekeeper will refuse it. Add `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets, dispatch the workflow, install the dmg once, then add the tag condition to both macOS jobs to make macOS part of every release.

Releases are cut by CI only. Never run `electron-builder --publish` locally — that is how tag `1.2.5` ended up on GitHub holding nothing but another version's blockmap.

1. Bump `version` in `package.json` in its own commit, and say what is shipping in the message — not "bump version". Two production defaults reached users inside commits messaged that way.
2. Tag that exact commit `vX.Y.Z`, matching the new version.
3. Push the branch, then the tag. The tag push is what builds and publishes.

CI refuses the release if the tag is not `vX.Y.Z`, disagrees with `package.json`, is not newer than every published release, or produces a `latest.yml` whose installers did not upload. It publishes the draft only once all of those pass.

## Configuration

Most knobs live in `src/shared/constants.js`:

| Constant                                 | Default                                     | Meaning                                          |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `INTERVIEW_BASE_URL`                     | — (`INTERVIEW_FRONTEND_BASE_URL` in `.env`) | Web app loaded during the interview              |
| `API_BASE_URL`                           | — (`API_BASE_URL` in `.env`)                | Backend                                          |
| `DEVTOOLS_ENABLED`                       | off (`DEVTOOLS` in `.env`)                  | Dock DevTools, allow F12 / Ctrl+Shift+I          |
| `DETECTION_INTERVAL_MS`                  | `5000`                                      | Live detection tick cadence                      |
| `VIOLATION_COOLDOWN_MS`                  | `15000`                                     | Min gap between repeats of the same violation    |
| `HEARTBEAT_INTERVAL_MS`                  | `30000`                                     | Backend heartbeat cadence                        |
| `INDETERMINATE_ESCALATION_THRESHOLD`     | `3`                                         | Consecutive unverifiable scans before escalating |
| `HARD_BLOCK_GRACE_MS`                    | `8000`                                      | Wait for an ack before re‑sending a hard block   |
| `AGENT_PORT`                             | `9999`                                      | Agent HTTP fallback port                         |
| `UPDATE_CHECK_INTERVAL_MS`               | 6 h                                         | Auto‑update re‑check cadence                     |
| `UPDATE_RETRY_MS` / `UPDATE_MAX_RETRIES` | 5 min / 3                                   | Sooner retries after a failed update check       |

Environment variables: `INTERVIEW_FRONTEND_BASE_URL` / `API_BASE_URL` (required), `DEVTOOLS`, `AGENT_PY` / `AGENT_PY_BIN` (dev agent), `AGENT_LOG_DIR` / `APP_VERSION` / `AGENT_SECRET` (set automatically for the spawned agent), `LOG_LEVEL` (main-process log verbosity, default `info`; see `src/main/logger.js`).

## Security hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload whitelists IPC channels (send/invoke/receive).
- Every `ipcMain` channel declares which caller it trusts (`ipcScope.js`): local `file://` pages or the interview origin. The interview site can't reach auth, navigation, kill, update or diagnostics channels.
- Navigation is restricted to the interview origin and `file://`; `window.open` is denied.
- Copy, view‑source, PrintScreen and the context menu are blocked (paste is allowed in form fields). F12 / Ctrl+Shift+I are blocked unless `DEVTOOLS` is on. F11 and Alt+F4 are blocked during interviews.
- The [interview lockdown](#interview-lockdown) is held for the whole session, not set once.
- Only media capture (local pages and the interview site) plus fullscreen and keyboard lock (interview site only) are granted; everything else is refused (`ipcScope.isPermissionAllowed`).
- Strict CSP on local `file://` pages.
- The agent HTTP fallback requires a per‑launch secret (`X-Agent-Token`) and restricts CORS; the primary pipe is parent‑only.
- `processKiller` can only kill apps on the blocked whitelist (or their registered relaunchers), never itself, its own process tree or the agent. PIDs and service names are validated before they reach a command line, and elevation is refused during an interview.
- Recording chunks are encrypted at rest (AES‑256‑GCM, key sealed by the OS keystore).
- Auth tokens live in the main process only, persisted via the OS keystore.

## Troubleshooting

| Symptom                                                       | Likely cause / fix                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight blocks on “Deep Scan Agent — Required”              | `agent.exe` didn’t start (AV quarantine, missing binary). Click **Re‑scan** (auto‑respawns). For dev, build it: `pnpm run build:agent`, or run `AGENT_PY=1`.        |
| Agent changes have no effect                                  | Dev/prod run `resources/agent.exe`. Rebuild with `pnpm run build:agent`, or use `AGENT_PY=1`.                                                                       |
| Single external display never passes                          | Any second display is a violation by design. Use a single screen.                                                                                                   |
| Violations don’t reach the web app                            | Ensure the page registers `onViolation` and runs inside this client (not a normal browser).                                                                         |
| White screen or "Can't reach your interview" in the interview | The interview site is unreachable or returned a 5xx; the app retries on its own. For a local build, check `.env` isn't pointing at a dev server that isn't running. |
| App points at no server / sign‑in fails immediately           | `.env` missing or incomplete. Both `INTERVIEW_FRONTEND_BASE_URL` and `API_BASE_URL` are required; there is no fallback.                                             |
| Blocked app shows “Reopened itself”                           | A background service or relauncher brought it back. Admins get **Close with admin rights**; others must turn off the app's auto‑start, then Rescan.                 |
| Closed app still shows as running                             | Check the log for `registered service … is not installed` — a wrong name in `APP_SERVICES` looks identical to a working one.                                        |
| Quit asks “Recording still uploading”                         | Chunks are still queued. _Finish upload_ waits up to 5 min; _Quit anyway_ resumes the upload on next launch.                                                        |
| Auto‑update “Cannot parse releases feed”                      | No published GitHub release for the configured repo; harmless in dev. Never shown to the candidate.                                                                 |

## npm scripts reference

| Script                    | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `start`                   | Launch Electron                                        |
| `dev`                     | Launch with file watching                              |
| `test`                    | Run the test suites (`node --test`)                    |
| `clean`                   | Remove build output (`scripts/clean.js`)               |
| `build:agent`             | PyInstaller build of the Python agent                  |
| `build:full` / `dist`     | Package the app (see [Building](#building--packaging)) |
| `dist:win` / `dist:mac`   | Package for a specific platform                        |
| `lint` / `lint:fix`       | ESLint                                                 |
| `format` / `format:check` | Prettier                                               |

---

© LetsHyre. Internal/proprietary.
