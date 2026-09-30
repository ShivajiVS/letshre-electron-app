# LetsHyre Secure Interview

A Windows/macOS Electron app that proctors LetsHyre interviews. It checks the machine before the interview (displays, meeting and screen-share apps, AI copilots, overlays, remote sessions, VMs), locks the screen, loads the interview site (`interview.letshyre.com`) in a locked window and records the screen. Anything it finds during the interview goes to the site as a **violation**; the site decides what it costs.

The version is in `package.json`.

## Architecture

```
┌─────────────── Electron main process (src/main, src/detector) ───────────────┐
│ windows + lockdown · IPC (scoped per caller) · detection engine · recording   │
│ auth (tokens never leave main) · locale · auto-update                         │
└──────┬──────────────────────────────┬──────────────────────────────┬─────────┘
       │ preload.js (contextBridge)   │ stdin/stdout pipe            │ HTTPS
       ▼                              ▼                              ▼
 Renderer windows               Python agent (agent.py)        LetsHyre API
 · setup pages (assets/*.html,  · deep scans: overlays, DLLs,  · login, profile,
   src/renderer/*.js)             virtual cameras/audio, VMs     identity, role
 · interview window (locked,    · Windows keyboard/touchpad    · violations,
   loads the interview site)      and focus lockdown             heartbeat, video
 · hidden recorder window
```

**Candidate path:** login → dashboard → language (only when more than one is offered) → security check → permissions → identity (photo + voice) → role → interview rules → **Start Interview**. From the security check on, a flow guard re-checks the machine every 2s and blocks each step until it is clear. Start locks the window, loads the interview site and starts detection every 5s. Findings go to the site as violations; the site decides the cost and tells the app when the interview ends, which lifts the lockdown.

**The app and the site** talk only through `window.electronAPI` (`preload.js`). Each channel is scoped to local pages or the interview origin (`src/main/ipcScope.js`). The session hands over tokens, photo, role, language (`?lang=`) and the rules acknowledgement. Both sides are pinned by [`contract/interview-contract.json`](contract/interview-contract.json).

```
main.js · preload.js · preload-recorder.js   entry and bridges
agent.py                                     deep-scan agent → resources/agent.exe
src/main/          lifecycle, windows, lockdown, IPC, flow guard, recording, auth, updater
src/detector/      detection engine, display and process scans, agent client
src/renderer/      one controller per setup page, step indicator, language dropdown
src/shared/        constants, flow step order, violation codes, blocked app lists
assets/            HTML pages, CSS design system, fonts, 19 locale bundles
contract/          what the app and the interview site promise each other
scripts/           agent build, release checks, contract sync, fonts, locales
test/              node:test unit suites, e2e/ (Electron), agent unittests
```

Full detail, including the lifecycle and the violation journey: [docs/architecture.md](docs/architecture.md).

## Run

Needs Node 20+, pnpm 10+, and Python 3.12 with `psutil` and `pyinstaller` for the agent.

```bash
pnpm install
cp .env.example .env        # set INTERVIEW_FRONTEND_BASE_URL and API_BASE_URL; there is no fallback
pnpm run build:agent        # builds resources/agent.exe from agent.py
pnpm dev                    # electron .
pnpm start                  # same, restarting on changes in src/, assets/ and the preloads
```

`AGENT_PY=1 pnpm dev` runs `agent.py` directly instead of the built binary. `DEVTOOLS=true` in `.env` enables DevTools.

## Test

```bash
pnpm test                   # unit tests (node --test)
pnpm run test:e2e           # Electron end-to-end suite
pnpm run lint
pnpm run format:check
python -m unittest discover -s test -p "test_*.py"   # agent tests
```

## Release

Bump `version` in its own commit, tag it `vX.Y.Z`, push the branch then the tag. CI builds, verifies and publishes. Never publish from a local machine. Run [docs/release-checklist.md](docs/release-checklist.md) on real hardware first. Details: [docs/release.md](docs/release.md).

## Docs

- [Architecture](docs/architecture.md): processes, repository layout, lifecycle, the violation journey, recording, backend endpoints, configuration, hardening
- [Detection](docs/detection.md): what is checked and when, the violation model, closing blocked apps, optional policy and telemetry endpoints
- [Lockdown](docs/lockdown.md): how the interview window is held and released
- [Web contract](docs/web-contract.md): what the interview site can rely on; machine-readable in [`contract/interview-contract.json`](contract/interview-contract.json)
- [Release](docs/release.md) and [release checklist](docs/release-checklist.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Where is it](docs/where-is-it.md): to change X, open Y
- Decisions: [fail closed](docs/decisions/fail-closed.md) · [the site owns enforcement](docs/decisions/site-owns-enforcement.md) · [a false strike is worse than a missed one](docs/decisions/false-strike-worse-than-miss.md) · [shadow mode before enforcement](docs/decisions/shadow-mode-before-enforcement.md) · [abort refused once proctoring starts](docs/decisions/abort-refused-once-proctoring-starts.md) · [interview window built locked](docs/decisions/interview-window-built-locked.md)
- [Contributing](CONTRIBUTING.md)

© LetsHyre. Internal/proprietary.
