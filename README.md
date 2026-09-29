# LetsHyre Secure Interview

A Windows/macOS Electron app that proctors LetsHyre interviews. It checks the machine before the interview (displays, meeting and screen-share apps, AI copilots, overlays, remote sessions, VMs), locks the screen, loads the interview site (`interview.letshyre.com`) in a locked window and records the screen. Anything it finds during the interview goes to the site as a **violation**; the site decides what it costs.

The version is in `package.json`.

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
