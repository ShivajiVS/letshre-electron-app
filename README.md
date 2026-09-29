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
   LOCKDOWN (windowManager.lockdownForInterview → lockdownGuard, osLockdown, displayShields)
   ├─ its own window, built kiosk + fullscreen + always-on-top; the app window hides
   ├─ held for the whole session (re-applied on drift, 1s watchdog)
   ├─ Windows: agent blocks system keys and touchpad gestures, pulls focus back
   ├─ macOS: on every Space, focus taken back when lost
   ├─ other displays covered in black
   ├─ navigation guardrails (only interview origin + file://)
   └─ load interview web app (tokens, photo, role, locale via sessionStorage)
            │
   LIVE MONITOR (systemChecks.start → runDetectionTick every 5s)
   ├─ external display / duplicate-mirror
   ├─ blocked processes launched mid-interview
   ├─ agent deep-scan threats
   ├─ agent reachability (anti-tamper)
   ├─ display added/removed → immediate tick (debounced 300ms)
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

`systemChecks.sendViolation(win, event, severity, { code, category, apps })` is the single choke point for every violation. It:

- **Tags** it with a UUID `id` and a machine‑readable `code` from `src/shared/violationCodes.js` (`suspicious_activity` when the caller gives none);
- **De‑duplicates** with a per‑event cooldown (`VIOLATION_COOLDOWN_MS`, 15s);
- **Escalates** repeat offences (`isHardBlock = severity === "high" || count >= 2`), except extra displays, which are never hard blocks: the site counts them as strikes;
- **Pushes** to the web app: `webContents.send("push-violation", payload)`;
- **Reports** to the backend (`POST /interview/violation`) via a bounded FIFO queue: network errors, 5xx, 408, 429 and 401 are retried with backoff (2s doubling to 60s); any other 4xx drops that report with a warning. Unsent reports are kept encrypted in `userData/pending-violations.bin` and sent after the next launch;
- **Holds** every violation until the web app acknowledges its `id`, re‑sending it if not ([see below](#detection-reliability--design-principles)).

Payload delivered to the renderer / backend (fields and codes: [Web app integration](#web-app-integration-the-contract)):

```jsonc
{
  "id": "0b6f3c1e-8f5d-4a52-9a41-7d2e6c9b1f03",
  "code": "blocked_app",
  "category": "browser", // the check that raised it, or null
  "apps": ["Google Chrome"],
  "event": "Blocked application running during interview: Google Chrome",
  "severity": "high", // "high" | "medium"
  "count": 1, // times this event has fired this session
  "isHardBlock": true, // high severity, or count >= 2; always false for extra displays
  "source": "electron",
  "timestamp": "2026-06-19T13:44:04.849Z",
  "sessionId": "sess_123", // from startProctoring; null until then, filled in while still queued
  "interviewId": "int_456",
  "appVersion": "1.4.4",
  "recordingOffsetMs": 61250, // position in the screen recording, null when not recording
}
```

## Interview lockdown

The interview runs in **its own window**, created already locked: frameless, kiosk, fullscreen, always‑on‑top (`screen-saver` level), not minimizable, maximizable, resizable or movable. On macOS it uses simple fullscreen, so it never gets a Space of its own. The app window hides meanwhile and comes back on the dashboard once the interview window closes. Locking a framed, maximized window at runtime didn't always stick (display scaling, several monitors), which is why it is built locked.

A window can only hold its own state, and the escapes that matter are the OS shell's: system keys, the taskbar, Task View, virtual desktops, touchpad gestures, other displays. Each part below covers one of them.

- **Window (`lockdownGuard.js`):** re‑applies the lock on minimize, fullscreen exit, always‑on‑top loss, maximize/restore and focus loss, with a 1s watchdog. The watchdog leaves a fullscreen transition alone for 1.5s rather than restarting it. A minimize attempt is a `high` violation, a fullscreen exit a `medium` one; an always‑on‑top drop is repaired silently.
- **Page fullscreen and keyboard lock:** keyboard lock is what keeps Alt+Tab and the Windows key inside the page, and it only holds while the page is fullscreen. The site can only ask for that from a click, so Electron puts the page into fullscreen as soon as it loads and again whenever it leaves (holding Esc), then calls `navigator.keyboard.lock()`.
- **Windows (`osLockdown.js` → agent `lockdown_*` commands):**
  - a low‑level keyboard hook swallows the Windows key (and with it every Win+ shortcut), Alt+Tab, Alt+Esc and Ctrl+Esc, including Ctrl+Shift+Esc, whether or not the page is fullscreen. It is renewed every 5s because Windows drops a slow hook silently;
  - every 250ms the agent checks which window is in front. If it isn't ours, it brings the interview back and reports `focus_lost` with the app's name;
  - leaving the current virtual desktop is reported as `virtual_desktop`;
  - three‑ and four‑finger touchpad gestures are switched off for the interview. The old values are saved to `%LOCALAPPDATA%\letshyre-secure-interview\touchpad-restore.json` first and put back when the interview ends, when the agent's pipe closes, or the next time the agent starts after a crash.
- **macOS (`osLockdown.js`):** the window is shown on every Space, so swiping Spaces or Mission Control still shows the interview, and when the app loses focus it takes it back (`app.focus({ steal: true })`) and reports `focus_lost`. Kiosk keeps the Dock, menu bar, Cmd+Tab and Force Quit away.
- **Other displays (`displayShields.js`):** every display but the interview's gets a black, always‑on‑top window that can't take focus, rebuilt when displays change. The extra display is still reported (`external_display`).
- **Alt+F4:** registered as a global shortcut only while the interview is locked; it is reported as a `high` violation and opens the exit dialog. F11 is blocked in‑window.
- **Diagnostics:** lockdown start logs the platform, every display's size and scale, and the window's kiosk, fullscreen and always‑on‑top state; focus loss, page fullscreen exits, keyboard lock results and the agent's lockdown state are logged too.
- **Page won't load:** if the interview site is unreachable or answers with a 5xx, the window shows `interview-unavailable.html` ("Can't reach your interview", with **Try again**) and retries after 3s, 5s, 10s, 20s, then every 30s. After three failed loads it also offers **Back to dashboard**, which releases the lockdown. Until then the lockdown stays on, and the session data is injected only into a page that actually loaded.
- **Interview never starts:** if the site hasn't called `startProctoring()` 90s after the lockdown, a dialog asks the candidate to keep waiting or go back to the dashboard, and asks again every 60s.
- **Released** only by `interviewComplete()`, `abortInterview()` before the interview starts, the two ways back above, the candidate confirming the exit dialog, or the interview window closing. `viewDashboard()` is ignored until the lockdown is released. The keyboard and touchpad are handed back before the agent stops.
- **Can't be blocked by any app:** Ctrl+Alt+Del, Win+L, UAC prompts and the power button. The focus watchdog reports what they leave behind.

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

**Unacknowledged violations.** Enforcement is the web app’s job: it shows the warning and termination screens and decides when to end the session. There is **no local violation page**.

A violation the web app doesn't acknowledge by `id` was probably missed (page still loading, reloading or down). Electron keeps the newest 20 (`MAX_UNACKED_VIOLATIONS`), soft and hard, and sends them all again, in order, on every later page load, with the same `id` and `redelivered: true`. A hard block is also sent once more after `HARD_BLOCK_GRACE_MS` (8s). An ack without an `id` acknowledges everything pending. Electron never lifts the lockdown or stops detection because of a missing ack.

> Until 1.4.0 a missing ack made Electron unlock the window and stop detection 8s later. The web app never sent acks, so the first hard block of any interview left a normal window behind. That was the "minimize / maximize / Alt+Tab work in the installed app" report.

## Web app integration (the contract)

The interview web app (`interview.letshyre.com`) runs inside this Electron window, so `window.electronAPI` is available to it. The integration is:

1. **Receive** violations and route them by `code`.
2. **Acknowledge** each violation by its `id`, so Electron knows the page received it. Unacknowledged violations are sent again.
3. **Signal completion** when the interview ends or you decide to terminate.

Live detection starts as soon as Start Interview hands off to the interview page: the first check runs immediately, then every 5s (`DETECTION_INTERVAL_MS`), so nothing goes unchecked between the pre-interview guard and the interview.

```js
// useElectronViolation.js (web app)
import { useEffect, useRef } from "react";

// Codes that end the interview the first time (see the table below).
const HARD_CODES = new Set([
  "blocked_app",
  "ai_tool",
  "renamed_app",
  "remote_session",
  "virtual_machine",
  "agent_unreachable",
  "check_unverified",
  "window_minimize",
  "close_attempt",
]);

export function useElectronViolation({ onHardBlock, onSoftBlock }) {
  const seen = useRef(new Set());

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onViolation) return; // running in a plain browser

    api.onViolation((payload) => {
      // 1) Ack FIRST, by id (before any modal guard), so it isn't sent again
      //    even while a warning is already open.
      api.acknowledgeViolation?.(payload.id);

      // 2) A redelivery of something already handled has the same id.
      if (seen.current.has(payload.id)) return;
      seen.current.add(payload.id);

      // 3) Route on code; payload.apps names the apps to show the candidate.
      if (payload.isHardBlock || HARD_CODES.has(payload.code)) onHardBlock?.(payload);
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

When the interview can't start (no attempts left, the start request fails), send the candidate back. It is refused once `startProctoring()` has been called:

```js
window.electronAPI.abortInterview("attempts-exhausted"); // any other reason shows "couldn't start" on the dashboard
```

**Violation payload.** `onViolation` and `POST /interview/violation` get the same object:

```jsonc
{
  "id": "0b6f3c1e-8f5d-4a52-9a41-7d2e6c9b1f03", // UUID, acknowledge with it
  "code": "blocked_app", // what happened: key your handling and copy on this
  "category": "meeting", // the check that raised it, or null
  "apps": ["Zoom", "Microsoft Teams"], // display names, may be empty
  "event": "Blocked application running during interview: Zoom, Microsoft Teams",
  "severity": "high", // "high" | "medium"
  "count": 1, // times this event text has fired this session
  "isHardBlock": true, // high severity, or count >= 2; always false for extra displays
  "source": "electron",
  "timestamp": "2026-09-25T10:15:04.849Z",
  "sessionId": "sess_123", // what startProctoring was given; null before it
  "interviewId": "int_456",
  "appVersion": "1.4.4",
  "recordingOffsetMs": 61250, // position in the screen recording, or null
  "redelivered": true, // only on a re-send, which keeps the original id
}
```

- `category` is a security-check id (`hdmi`, `meeting`, `screen`, `wireless`, `browser`, `ai`, `agent`), or `null` for window events and for the process check as a whole.
- `event` is plain English for older site builds and logs. Key new code on `code` and show `apps`: `event` wording isn't a contract.
- For agent threats `event` is built from the code and the app names ("AI tool detected: parakeetai-desktop"). The agent's own detail can hold file paths, window titles and IP addresses, so it only goes to the local audit log.
- The 15s cooldown and the escalation (`count`, `isHardBlock`) are per `event` text.
- A site may treat a code as harder than `isHardBlock` says, never softer.

**Codes** (`src/shared/violationCodes.js`):

| Code                  | Meaning                                                                                                                                                | Treat as                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `blocked_app`         | A blocklisted meeting, screen‑share, casting/remote or browser app is running. One violation per category, apps in `apps`                              | Hard                      |
| `ai_tool`             | An AI assistant is running: on the blocklist (`category: "ai"`) or found by the agent (`"agent"`)                                                      | Hard                      |
| `overlay`             | Agent: a transparent overlay window is over the screen                                                                                                 | Soft; hard if it persists |
| `renamed_app`         | Agent: a blocked app is running under another name                                                                                                     | Hard                      |
| `external_display`    | A second display is connected (HDMI, DisplayPort, USB‑C, wireless). Re‑sent every 15s while it stays connected                                         | Strike (never hard)       |
| `mirrored_display`    | One display, but more physical monitors behind it ("Duplicate these displays"). Re‑sent every 15s while it stays                                       | Strike (never hard)       |
| `remote_session`      | Agent: the computer is being used through remote desktop                                                                                               | Hard                      |
| `virtual_machine`     | Agent: the computer is a virtual machine                                                                                                               | Hard                      |
| `suspicious_activity` | Any other agent finding (window titles, modules, network, automation, virtual audio), or an event without its own code (deep‑link swap)                | Follow `isHardBlock`      |
| `agent_unreachable`   | The security agent didn't answer, or couldn't finish its checks, 3 times in a row: it may have been killed                                             | Hard                      |
| `check_unverified`    | The display (`hdmi`) or process (`null`) check couldn't answer 3 times in a row                                                                        | Hard                      |
| `window_minimize`     | The candidate tried to minimize the window (undone)                                                                                                    | Hard                      |
| `fullscreen_exit`     | The candidate left fullscreen (undone)                                                                                                                 | Soft; hard on repeat      |
| `close_attempt`       | The candidate opened the exit dialog and cancelled it                                                                                                  | Hard                      |
| `focus_lost`          | Another app came to the front (Windows: its name is in `apps`). Electron brings the interview back; the site's own focus tracking already strikes this | Site decides (never hard) |
| `virtual_desktop`     | Windows: the interview window is no longer on the current virtual desktop                                                                              | Site decides (never hard) |

Every agent threat code in a scan is sent, not only the first. Threats sharing a code are one violation, with all their apps.

**Acknowledgement and redelivery.** Call `acknowledgeViolation(payload.id)` first thing in the handler. Without an id it acknowledges everything pending, which is what builds from before ids do.

- Electron keeps every violation, soft and hard, until it is acknowledged: the newest 20 (`MAX_UNACKED_VIOLATIONS`), oldest dropped first.
- Each time the interview page finishes loading, all of them are sent again, in order, with the same `id` and `redelivered: true`.
- An unacknowledged hard block is also sent once more after 8s (`HARD_BLOCK_GRACE_MS`).
- A redelivery is the same violation, not a new one: dedupe on `id` so it doesn't count twice toward a termination threshold. The backend gets each violation once (queued and retried), with the same `id`.
- None of this touches the lockdown: only `interviewComplete()` or a confirmed exit unlocks the window.

> ⚠️ If the web app doesn't call `acknowledgeViolation()`, every violation is sent again on each page load, and each hard block once more after 8s. The lockdown is unaffected either way.

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
| `acknowledgeViolation(id)`                                                                          | Confirm receipt of that violation so it isn't sent again; without an `id`, acknowledges everything pending                   |
| `interviewComplete(reason)`                                                                         | End the session; lifts lockdown                                                                                              |
| `viewDashboard()`                                                                                   | Scorecard "View Dashboard" button; leaves for the dashboard once the lockdown is released                                    |
| `abortInterview(reason)`                                                                            | The interview couldn't start; releases the lockdown and goes back to the dashboard (refused once it has started)             |
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

| Endpoint                                                                          | When                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /user/v1/login/` · `POST /user/v1/login_refresh/` · `POST /user/v1/logout/` | Sign‑in, token refresh, sign‑out                                                                                                      |
| `GET /user/v1/candidate_profile/`                                                 | Dashboard; also verifies the saved session at launch                                                                                  |
| `POST /user/v1/candidate/interview/face_verification/`                            | Identity verification photo                                                                                                           |
| `POST /user/v1/candidate/interview/voice_sample/`                                 | Identity verification voice sample                                                                                                    |
| `POST /user/v1/candidate_resume_ai/skills_for_role/`                              | Role selection                                                                                                                        |
| `POST /user/v1/candidate_interview/video_upload/start/`                           | Register a recording upload                                                                                                           |
| `POST /user/v1/candidate_interview/video_upload/chunk/`                           | Each recording chunk, during the interview                                                                                            |
| `POST /user/v1/candidate_interview/video_upload/complete/`                        | After the last chunk is confirmed                                                                                                     |
| `GET /user/v1/candidate_interview/video_upload/status/<uploadId>/`                | Poll until the backend has merged the video                                                                                           |
| `POST /interview/heartbeat`                                                       | Every 30s during the interview — `{ timestamp, sessionId, interviewId, appVersion }`                                                  |
| `POST /interview/violation`                                                       | On every violation (retried, also after a restart) — the [violation payload](#violation-model); dedupe on `id`; a 4xx other than 401/408/429 drops it |

> **Required for enforcement:** `POST /interview/violation` must be implemented server‑side to record/flag/terminate sessions. Until it exists, violation reports are queued and retried client‑side.

### Optional security-check endpoints

Both are off unless their path is set in `.env` (relative to `API_BASE_URL`, must start with `/`). Both send `Authorization: Bearer <accessToken>` with a 5s timeout and never hold up the candidate.

**Blocklist policy** — `GET <PREFLIGHT_POLICY_PATH>`, once on Start Interview; cleared on logout and on returning to the dashboard.

```json
{
  "allow": ["slack.exe", "slack.app"],
  "block": [{ "name": "examtool.exe", "category": "screen", "displayName": "Exam Tool" }]
}
```

- `allow` removes built-in entries; AI tools can't be allowed. `block` adds image names to a card: `meeting`, `screen`, `wireless`, `browser` or `ai`. `displayName` is optional.
- Names are lowercased and must match `^[\w.\- ]{1,120}$`; at most 200 entries per list. Invalid entries and OS/app process names are dropped.
- The result drives detection, the check cards, the kill whitelist and the page's app names. Unset, failing or invalid → the built-in lists.

**Scan telemetry** — `POST <PREFLIGHT_TELEMETRY_PATH>` after each security-check scan the page keeps. No process names, paths or personal data:

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
- **Simulate a violation** — with `DEVTOOLS` on in an unpackaged run, call
  `await window.electronAPI.devSimulateViolation("blocked_app")` from the interview page's console to
  fire any code through the real pipeline (push, backend report, ack). Refused otherwise.
- **Logs** — the main process and forwarded agent logs are written to
  `…/AppData/Roaming/letshyre-secure-interview/secure-interview.log` (Windows).
  Each line is tagged `[run:<id>]` for the launch and `sess:<sessionId>` during an interview;
  audit events carry the same `runId` and `sessionId`.

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

Environment variables: `INTERVIEW_FRONTEND_BASE_URL` / `API_BASE_URL` (required), `DEVTOOLS`, `SUPPORT_URL`, `PREFLIGHT_POLICY_PATH` / `PREFLIGHT_TELEMETRY_PATH` (optional, see [Optional security-check endpoints](#optional-security-check-endpoints)), `AGENT_PY` / `AGENT_PY_BIN` (dev agent), `AGENT_LOG_DIR` / `APP_VERSION` / `AGENT_SECRET` (set automatically for the spawned agent), `LOG_LEVEL` (main-process log verbosity, default `info`; see `src/main/logger.js`).

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
