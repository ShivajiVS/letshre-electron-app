# Building and releasing

Before any release, run the hardware checks in [release-checklist.md](release-checklist.md).

## Building

```bash
pnpm run build:agent    # PyInstaller → resources/agent.exe   (run when agent.py changes)
pnpm run build:full     # build:agent + electron-builder, for this machine
pnpm run dist           # package for this machine
pnpm run dist:win       # package for Windows
pnpm run dist:mac       # package for macOS
```

Output goes to `release/` (NSIS installer on Windows, DMG on macOS). The agent binary is per-platform and PyInstaller cannot cross-compile, so `dist:mac` needs a Mac to have produced `resources/agent`.

> **`.env` is checked before every package** (`scripts/check-env.js`, an electron-builder `beforePack` hook, so CI's direct `electron-builder` call is covered too). Both hosts must be set, use https and not point at `localhost`, loopback or `.local`. For a local test build against a dev server, set `ALLOW_DEV_ENV=1`.

> **`resources/agent.exe` is gitignored.** It is a build artifact rebuilt from `agent.py`. Always run `build:agent` (or `build:full`) before packaging so the bundled binary matches the current `agent.py`. The `dist` scripts refuse to package when it does not (`scripts/check-agent-freshness.js`), comparing the source hash recorded in `resources/agent.build.json`. The running app compares the agent it talks to against the same hash (`src/shared/agentBuild.js`).

## Releasing

Releases are cut by CI only (`.github/workflows/build.yml`). Never run `electron-builder --publish` locally: that is how tag `1.2.5` ended up on GitHub holding nothing but another version's blockmap.

1. Bump `version` in `package.json` in its own commit, and say what is shipping in the message, not "bump version". Two production defaults reached users inside commits messaged that way.
2. Tag that exact commit `vX.Y.Z`, matching the new version.
3. Push the branch, then the tag. The tag push is what builds and publishes.

CI runs tests, lint and format check, builds the agent on Windows, packages, and then `scripts/verifyRelease.js` refuses the release if the tag is not `vX.Y.Z`, disagrees with `package.json`, is not newer than every published release, or produces a `latest.yml` whose installers did not upload. It publishes the draft only once all of those pass.

If the release changes the contract (new code, new method), land it here first. The site raises `VITE_MIN_DESKTOP_VERSION` only after this release is out. See [CONTRIBUTING.md](../CONTRIBUTING.md).

### macOS

macOS builds run on manual workflow dispatch only. The jobs are wired up, but no dmg has been produced or installed yet, and without an Apple Developer ID certificate the build is unsigned and Gatekeeper will refuse it. Add `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets, dispatch the workflow, install the dmg once, then add the tag condition to both macOS jobs to make macOS part of every release.

## Auto-update

`updater.js` uses `electron-updater` against GitHub releases. It checks at launch and every 6 hours (retrying sooner, up to 3 times, after a failure), **downloads new versions automatically in the background**, and installs them the next time the app is closed. Nothing is checked, downloaded or installed while an interview is active.

Progress is shown by a floating card (`src/renderer/updateCard.js` + `assets/css/update-card.css`) on **every local page**: sign‑in, dashboard, language and role selection, how it works, permissions, identity verification and the security check. It is not shown during the interview: that runs on the interview site, which doesn't load the card and can't reach the update channels. Each page pulls the current state on load, so an update staged between pages still appears.

| Card             | Shows                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Update available | Version, "Downloading in the background (X MB)…", optional _What's new_                                                             |
| Downloading      | Progress bar, percentage, MB transferred                                                                                            |
| Update ready     | _Update now_ (closes the app and installs; it does **not** relaunch: the candidate reopens from their interview link) and _Dismiss_ |

Update‑check failures are logged only; the candidate never sees them.

## npm scripts

| Script                           | Description                                                     |
| -------------------------------- | --------------------------------------------------------------- |
| `dev`                            | Launch Electron (`electron .`)                                  |
| `start`                          | Launch with file watching (nodemon on `src`, `assets`, preload) |
| `test`                           | Unit tests (`node --test`)                                      |
| `test:e2e`                       | Electron end-to-end suite (`test/e2e/run.js`)                   |
| `lint` / `lint:fix`              | ESLint                                                          |
| `format` / `format:check`        | Prettier                                                        |
| `contract:sync <site>`           | Copy `contract/interview-contract.json` into a site checkout    |
| `clean`                          | Remove build output (`scripts/clean.js`)                        |
| `build:agent`                    | PyInstaller build of the Python agent                           |
| `build:full`                     | `build:agent` + electron-builder                                |
| `dist` / `dist:win` / `dist:mac` | Package with the existing agent binary (freshness-checked)      |
