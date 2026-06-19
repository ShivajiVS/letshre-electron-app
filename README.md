# LetsHyre Secure Interview

A Windows/macOS **Electron desktop client** that proctors online interviews. It runs a battery of security checks **before** an interview (preflight) and **continuously during** it, then hosts the LetsHyre web interview (`interview.letshyre.com`) inside a locked‑down browser window. If it detects cheating vectors — external monitors, screen mirroring, meeting/recording apps, AI interview copilots (Parakeet, Cluely, Final Round AI, …), transparent overlays, virtual audio cables, browser automation — it raises a **violation** to the web app and, as a failsafe, can enforce it locally.

> **Status:** active. The detection layer was recently overhauled for reliability; see [Detection reliability](#detection-reliability--design-principles).

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Application lifecycle](#application-lifecycle)
- [Detection layers](#detection-layers)
- [Violation model](#violation-model)
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

1. The candidate launches the app from the web via a `letshyre://` **deep link** carrying their session token.
2. The app runs a **preflight** scan (`assets/preflight.html`). The candidate cannot proceed until every check is green: no external displays, no meeting/recording/casting apps, no AI copilot tools, and the deep‑scan agent is running.
3. On **Proceed**, the window enters **lockdown** (kiosk + always‑on‑top + navigation guardrails) and loads the interview web app.
4. During the interview, detection runs on a fixed cadence. Any finding is pushed to the web app as a **violation** and reported to the backend.
5. When the interview ends, the web app signals completion and the lockdown is lifted.

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
              │  preflight.html  ─┐  │     │  8 behavioural checks   │
              │  interview web app│  │     │  primary: stdio pipe    │
              │  violation.html  ─┘  │     │  secondary: HTTP :9999  │
              └──────────────────────┘     └────────────────────────┘
```

Two cooperating detection tiers:

- **Node tier** (main process) — displays and running processes, using native OS APIs.
- **Python agent** (`agent.py`, shipped as `agent.exe`) — *behavioural* deep checks that Node cannot do cheaply: network fingerprinting, loaded‑DLL signatures, window titles/classes, transparent overlays, virtual audio devices, browser‑automation drivers, and a physical‑monitor count.

## Tech stack

| Area | Choice |
|------|--------|
| Desktop shell | **Electron 30** (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| Main/renderer language | Node.js **20+** (CommonJS) |
| Deep‑scan agent | **Python 3.12** + `psutil`, bundled to a single binary with **PyInstaller** |
| UI | Static HTML + **Tailwind CSS 3** |
| Packaging | **electron-builder 24** (NSIS installer on Windows, DMG on macOS) |
| Auto‑update | `electron-updater` (GitHub releases) |
| Lint/format | ESLint 8 + Prettier 3 |

## Repository layout

```
.
├── main.js                     # entry shim → src/main/index.js
├── agent.py                    # Python deep-scan agent (source of resources/agent.exe)
├── preload.js                  # contextBridge: exposes window.electronAPI to all pages
├── scripts/build_agent.py      # PyInstaller build → resources/agent.exe
│
├── src/
│   ├── main/                   # Electron main process
│   │   ├── index.js            # single-instance lock, protocol registration
│   │   ├── app.js              # app lifecycle (onReady, updater, screen capture)
│   │   ├── windowManager.js    # window creation, kiosk lockdown, CSP, self-enforcement
│   │   ├── ipcHandlers.js      # the only file that registers ipcMain channels
│   │   ├── agentManager.js     # spawn agent, stdin/stdout pipe, ensureAgent()
│   │   ├── protocolHandler.js  # letshyre:// parsing → interview URL + token
│   │   ├── processKiller.js    # whitelisted force-kill of blocked apps
│   │   ├── appState.js         # quitting flag
│   │   └── logger.js           # file logger (userData/secure-interview.log)
│   │
│   ├── detector/               # detection logic (runs in main process)
│   │   ├── systemChecks.js     # detection ENGINE: preflight + live tick + violations
│   │   ├── hdmiDetector.js     # external-display detection (Electron screen API)
│   │   ├── mirrorDetector.js   # blocked-process scan (tasklist CSV / ps)
│   │   └── agentClient.js      # talks to the Python agent (pipe-first, HTTP fallback)
│   │
│   ├── renderer/               # page controllers (sandboxed renderer)
│   │   ├── preflight.js
│   │   └── violation.js
│   │
│   └── shared/
│       ├── constants.js        # single source of truth: ports, URLs, IPC names, timings
│       └── appList.js          # blocked app lists + friendly display names
│
├── assets/                     # static UI (HTML/CSS/icons) loaded as file://
│   ├── preflight.html / .js    # preflight screen (loads src/renderer/preflight.js)
│   └── violation.html          # local violation/terminal screen (self-enforcement)
│
└── resources/agent.exe         # built agent binary (gitignored — rebuild before packaging)
```

## Application lifecycle

```
launch (deep link) ─▶ onReady (src/main/app.js)
   ├─ logger.init
   ├─ spawnAgent() + waitForAgent()      # Python agent over the stdin/stdout pipe
   ├─ registerIpcHandlers()
   ├─ applyArgvDeepLink()                # Windows: read token from argv
   └─ createWindow() → preflight.html
            │
   PREFLIGHT (gate)
   ├─ runPreflight  → runChecksOnce()    # hdmi + processes + agent deep scan + physical monitors
   ├─ ensureAgent()                      # respawn agent if it died (self-heal on re-scan)
   └─ pre-proceed monitor (every 2s)     # keeps Proceed button state live
            │  user clicks Proceed
            ▼
   LOCKDOWN (windowManager.lockdownForInterview)
   ├─ kiosk + always-on-top + minimizable(false)
   ├─ navigation guardrails (only interview origin + file://)
   └─ load interview web app
            │
   LIVE MONITOR (systemChecks.start → runDetectionTick every 5s)
   ├─ external display / duplicate-mirror
   ├─ blocked processes launched mid-interview
   ├─ agent deep-scan threats
   ├─ agent reachability (anti-tamper)
   └─ heartbeat to backend (every 30s)
            │  web app signals interviewComplete
            ▼
   END (stop detection, lift lockdown)
```

## Detection layers

**Node tier**

| Check | How | File |
|-------|-----|------|
| External / extended displays | `screen.getAllDisplays()` (native, instant) | `src/detector/hdmiDetector.js` |
| Blocked apps running | `tasklist /FO CSV` (Win) / `ps` (mac), exact image-name match | `src/detector/mirrorDetector.js` |

**Python agent (`agent.py`)** — eight behavioural checks plus a physical‑monitor count:

1. Window‑title scan (Win32 / AppleScript / wmctrl)
2. Suspicious network connections (AI/cheating API domains, via `psutil` + reverse DNS)
3. Loaded‑DLL / module signatures (`tasklist /M`, catches renamed binaries)
4. Browser‑automation drivers (ChromeDriver, Selenium, …)
5. Suspicious Win32 window classes
6. AI interview‑copilot tools (process name / install path / stealth cmdline flags)
7. Transparent click‑through overlays (`WS_EX_LAYERED|TRANSPARENT|TOPMOST`)
8. Virtual audio devices (VB‑Cable, Voicemeeter, …)
9. **Physical monitor count** (`EnumDisplayDevices`) — catches Windows *“Duplicate”* mode, which the logical‑display API reports as a single screen.

The blocked‑app lists (meeting, screen‑share, casting, browsers, AI tools) and their friendly names live in one place: `src/shared/appList.js`.

## Violation model

`systemChecks.sendViolation(win, event, severity)` is the single choke point for every violation. It:

- **De‑duplicates** with a per‑event cooldown (`VIOLATION_COOLDOWN_MS`, 15s);
- **Escalates** repeat offences (`isHardBlock = severity === "high" || count >= 2`);
- **Pushes** to the web app: `webContents.send("push-violation", payload)`;
- **Reports** to the backend (`POST /interview/violation`) via a bounded FIFO retry queue;
- **Arms** the self‑enforcement failsafe for hard blocks (see below).

Payload delivered to the renderer / backend:

```jsonc
{
  "event": "Blocked application running during interview: Google Chrome",
  "severity": "high",          // "high" | "medium"
  "count": 1,                  // times this event has fired this session
  "isHardBlock": true,         // high severity, or count >= 2
  "source": "electron",
  "timestamp": "2026-06-19T13:44:04.849Z"
}
```

## Detection reliability & design principles

The detection layer follows three rules that make it predictable:

- **Fail‑closed, never fail‑open.** A check that errors or times out returns `indeterminate`, not “clean”. During a live interview, several consecutive `indeterminate` results (`INDETERMINATE_ESCALATION_THRESHOLD`) escalate to a violation — a transient probe failure can never be a silent bypass.
- **One verdict path.** All live checks run in a single `runDetectionTick` and route through one `sendViolation`, so there is no duplicate timer, race, or double‑fire.
- **Pipe‑first agent.** Electron talks to the agent over a stdin/stdout JSON pipe (no TCP port → immune to AV/firewall/port conflicts). HTTP `:9999` remains only as a best‑effort fallback, and a failed bind is non‑fatal.

**Self‑enforcement failsafe.** Enforcement is normally the web app’s job (it shows warnings and decides when to terminate). But if the renderer drops the event or crashes, a hard block would have no consequence. So on a hard block Electron arms an 8s grace timer (`HARD_BLOCK_GRACE_MS`); if the web app keeps **acknowledging** violations it stays in control, but if no ack arrives, Electron self‑enforces by lifting the lockdown and loading `assets/violation.html`. See the next section.

## Web app integration (the contract)

The interview web app (`interview.letshyre.com`) runs inside this Electron window, so `window.electronAPI` is available to it. The integration is:

1. **Receive** violations and route hard vs soft.
2. **Acknowledge** every violation so Electron knows the page is alive (this suppresses the self‑enforcement failsafe and lets your in‑app warning UX stay in control).
3. **Signal completion** when the interview ends or you decide to terminate.

```js
// useElectronViolation.js (web app)
import { useEffect } from "react";

export function useElectronViolation({ onHardBlock, onSoftBlock }) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onViolation) return;            // running in a plain browser

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

> ⚠️ If the deployed web app does **not** call `acknowledgeViolation()`, no acks arrive and every hard block will self‑enforce after the 8s grace. Ship the ack alongside this client.

## Renderer API (`window.electronAPI`)

Exposed by `preload.js` via `contextBridge` (only whitelisted channels). Safe to call in a plain browser — methods no‑op if `electronAPI` is absent.

| Method | Purpose |
|--------|---------|
| `runPreflight()` | Run all preflight scans; resolves with `{ hdmi, mirror, agent }` |
| `onPreflightProgress(cb)` / `removePreflightProgressListener()` | Per‑step streaming progress |
| `onPreProceedStatus(cb)` / `removePreProceedStatusListener()` | Live blocked‑app status on the success screen |
| `proceedToInterview()` | Enter lockdown and load the interview |
| `killProcess(name)` / `killAllProcesses(names)` | Force‑close a blocked app (whitelisted) |
| `onViolation(cb)` / `removeViolationListener()` | Receive violations during the interview |
| `acknowledgeViolation()` | Confirm receipt (suppresses self‑enforcement) |
| `interviewComplete(reason)` | End the session; lifts lockdown |
| `recheckSystem()` / `minimizeWindow()` / `quitApp()` | Preflight UX controls |
| `getAppList()` / `getAuditLog()` | Blocked‑app lists; in‑memory audit log |
| `onUpdateAvailable(cb)` / `onUpdateDownloaded(cb)` / `installUpdate()` | Auto‑updater UX |

## Deep link protocol

Registered scheme: **`letshyre://`**

```
letshyre://start?ac=<accessToken>&rc=<refreshToken>
```

`ac` (access) and `rc` (refresh) are parsed in `src/main/protocolHandler.js`, used to build the interview URL (`https://interview.letshyre.com?ac=…&rc=…`) and to authenticate backend calls. A protocol activation **during** an active interview is treated as a high‑severity violation (possible session swap).

## Backend endpoints expected

The client calls these on `API_BASE_URL` (default `https://api.letshyre.com`) with `Authorization: Bearer <accessToken>`:

| Endpoint | When | Body |
|----------|------|------|
| `POST /interview/heartbeat` | Every 30s during the interview | `{ timestamp }` |
| `POST /interview/violation` | On every violation (retried) | `{ event, severity, count, isHardBlock, source, timestamp }` |

> **Required for enforcement:** `POST /interview/violation` must be implemented server‑side to record/flag/terminate sessions. Until it exists, violation reports are queued and retried client‑side.

## Getting started

### Prerequisites

- **Node.js ≥ 20** and **npm ≥ 10**
- **Python 3.12** with `psutil` (and `pyinstaller` to build the agent binary):
  ```bash
  pip install psutil pyinstaller
  ```

### Install

```bash
npm install
```

### Run (development)

```bash
npm run dev      # builds CSS, then launches Electron with file watching (nodemon)
# or
npm start        # plain electron .
```

> In dev and production the app runs the **bundled** `resources/agent.exe`, not `agent.py`. To iterate on the agent without rebuilding, set `AGENT_PY=1` (see below).

## Development

- **Iterate on the Python agent without rebuilding** — run the source directly:
  ```bash
  AGENT_PY=1 npm start        # spawns `python agent.py` instead of resources/agent.exe
  ```
  (`AGENT_PY_BIN` overrides the interpreter, default `python`/`python3`. Dev only.)
- **Tailwind** — `npm run watch:css` rebuilds styles on change.
- **Lint / format** — `npm run lint` / `npm run format`.
- **Logs** — the main process and forwarded agent logs are written to
  `…/AppData/Roaming/letshyre-secure-interview/secure-interview.log` (Windows).

## Building & packaging

```bash
npm run build:css      # compile Tailwind
npm run build:agent    # PyInstaller → resources/agent.exe   (run when agent.py changes)
npm run build:full     # build:css + build:agent + electron-builder
npm run build          # build:css + electron-builder (assumes agent already built)
npm run dist           # cross-target (win + mac)
```

Output goes to `release/` (NSIS installer on Windows, DMG on macOS).

> **`resources/agent.exe` is gitignored** — it is a build artifact rebuilt from `agent.py`. Always run `build:agent` (or `build:full`) before packaging so the bundled binary matches the current `agent.py`.

## Configuration

Most knobs live in `src/shared/constants.js`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `INTERVIEW_BASE_URL` | `https://interview.letshyre.com` | Web app loaded during the interview |
| `API_BASE_URL` | `https://api.letshyre.com` | Backend; **overridable via `API_BASE_URL` env** |
| `DETECTION_INTERVAL_MS` | `5000` | Live detection tick cadence |
| `VIOLATION_COOLDOWN_MS` | `15000` | Min gap between repeats of the same violation |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Backend heartbeat cadence |
| `INDETERMINATE_ESCALATION_THRESHOLD` | `3` | Consecutive unverifiable scans before escalating |
| `HARD_BLOCK_GRACE_MS` | `8000` | Grace before Electron self‑enforces a hard block |
| `AGENT_PORT` | `9999` | Agent HTTP fallback port |

Environment variables: `API_BASE_URL` (staging/test backend), `AGENT_PY` / `AGENT_PY_BIN` (dev agent), `AGENT_LOG_DIR` / `APP_VERSION` / `AGENT_SECRET` (set automatically for the spawned agent).

## Security hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload whitelists IPC channels (send/invoke/receive).
- Navigation is restricted to the interview origin and `file://`; `window.open` is denied.
- DevTools and common shortcuts (copy/paste/view‑source/PrintScreen/F12, and Alt+F4 during interviews) are blocked.
- Strict CSP on local `file://` pages.
- The agent HTTP fallback requires a per‑launch secret (`X-Agent-Token`) and restricts CORS; the primary pipe is parent‑only.
- `processKiller` can only kill apps on the blocked whitelist and never itself or the agent.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Preflight blocks on “Deep Scan Agent — Required” | `agent.exe` didn’t start (AV quarantine, missing binary). Click **Re‑scan** (auto‑respawns). For dev, build it: `npm run build:agent`, or run `AGENT_PY=1`. |
| Agent changes have no effect | Dev/prod run `resources/agent.exe`. Rebuild with `npm run build:agent`, or use `AGENT_PY=1`. |
| Single external display never passes | Any second display is a violation by design. Use a single screen. |
| Violations don’t reach the web app | Ensure the page registers `onViolation` and runs inside this client (not a normal browser). |
| Hard block force‑navigates mid‑interview | The web app isn’t calling `acknowledgeViolation()`. Add it to your violation handler. |
| Auto‑update “Cannot parse releases feed” | No published GitHub release for the configured repo; harmless in dev. |

## npm scripts reference

| Script | Description |
|--------|-------------|
| `start` | Launch Electron |
| `dev` | Build CSS, then launch with file watching |
| `build:css` / `watch:css` | Compile / watch Tailwind |
| `build:agent` | PyInstaller build of the Python agent |
| `build` / `build:full` / `dist` | Package the app (see [Building](#building--packaging)) |
| `lint` / `lint:fix` | ESLint |
| `format` / `format:check` | Prettier |

---

© LetsHyre. Internal/proprietary.
