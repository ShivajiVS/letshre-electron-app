# Contributing

## Branches and PRs

- Branch off `main`, keep it short-lived, and name it for the change: `fix/overlay-false-positive`, `feat/kiosk-lockdown`.
- Open a PR into `main`. CI runs tests, lint and format check (`.github/workflows/build.yml`); all three must pass.
- Label the PR (`feature`, `fix`, `security`, `chore`, `docs`, …). Release Drafter builds the release notes and the next version from the labels.
- One change per PR. A refactor that a fix needs goes in its own commit.

Before pushing:

```bash
pnpm test
pnpm run lint
pnpm run format:check
```

If you touched `agent.py`, also run `pnpm run build:agent` and the agent tests (`python -m unittest discover -s test -p "test_*.py"`). If you touched the lockdown, the security check or recording, run the relevant rows of [docs/release-checklist.md](docs/release-checklist.md) on real hardware.

## The contract with the interview site

`contract/interview-contract.json` is what the site builds against: violation codes, the `electronAPI` methods the site may call, the sessionStorage handoff and the reasons. See [docs/web-contract.md](docs/web-contract.md).

- **Contract changes land here first.** Change the code and the JSON in the same PR; `test/contract.test.js` fails if they disagree.
- **Stay backward compatible.** The site runs against every app version still installed. Add codes, methods and keys; don't rename or remove them. A new method is feature-detected by the site (`window.electronAPI?.newMethod`). If you must remove or change the meaning of something, bump `version` in the contract and keep the old behaviour until the site no longer relies on it.
- After the app PR merges, `pnpm contract:sync <path-to-site-checkout>` and open the site PR with the copy and its handling.
- **The site raises `VITE_MIN_DESKTOP_VERSION`** once it relies on the new app API, and only after that app version is released.

## Commit messages

Conventional commits, as in `git log`:

```
feat(lockdown): hold the interview lockdown against OS-level escapes
fix(preflight): stop the security check refreshing itself and simplify its layout
chore(release): bump version to 1.4.3
```

- Types: `feat`, `fix`, `refactor`, `perf`, `style`, `test`, `docs`, `ci`, `chore`.
- Scope is the area: `lockdown`, `preflight`, `guard`, `detection`, `agent`, `recorder`, `updater`, `i18n`, `identity`, `auth`, `ui`, `release`.
- Subject in the imperative, lower case, no full stop, saying what changes for the candidate or the code, not "update file".
- Body: a short list of what changed and why, when the subject isn't enough.
- Version bumps get their own `chore(release): bump version to X.Y.Z` commit that says what ships. See [docs/release.md](docs/release.md).

## Docs

Update the page in `docs/` that describes what you changed, and [docs/where-is-it.md](docs/where-is-it.md) if you added a new place to look. A decision that future changes should respect goes in `docs/decisions/`.
