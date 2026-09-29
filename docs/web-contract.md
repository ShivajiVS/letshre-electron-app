# Web contract

What the interview site (`interview.letshyre.com`) can rely on from the desktop app, and what the app expects back.

The machine-readable version is [`contract/interview-contract.json`](../contract/interview-contract.json). `test/contract.test.js` fails when it drifts from `violationCodes.js`, the interview-scoped IPC channels, `preload.js` or the sessionStorage handoff in `windowManager.js`. The site keeps a copy in `src/contract/` and its own test fails when a code has no mapping there.

To change the contract:

1. Change the app and `contract/interview-contract.json` together, in the app repo. Bump `version` when something is removed or changes meaning.
2. `pnpm contract:sync <path-to-site-checkout>` copies it into the site.
3. Handle it in the site. If the site now depends on something only a new app has, it raises `VITE_MIN_DESKTOP_VERSION`. See [CONTRIBUTING.md](../CONTRIBUTING.md).

- [Integration in three steps](#integration-in-three-steps)
- [Violation payload](#violation-payload)
- [Codes](#codes)
- [Acknowledgement and redelivery](#acknowledgement-and-redelivery)
- [Ending, aborting, leaving](#ending-aborting-leaving)
- [Recording failures](#recording-failures)
- [sessionStorage handoff](#sessionstorage-handoff)
- [Deep link protocol](#deep-link-protocol)
- [Renderer API](#renderer-api-windowelectronapi)

## Integration in three steps

The interview web app runs inside the Electron window, so `window.electronAPI` is available to it.

1. **Receive** violations and route them by `code`.
2. **Acknowledge** each violation by its `id`, so Electron knows the page received it. Unacknowledged violations are sent again.
3. **Signal completion** when the interview ends or you decide to terminate.

Live detection starts as soon as Start Interview hands off to the interview page: the first check runs immediately, then every 5s (`DETECTION_INTERVAL_MS`).

```js
// useElectronViolation.js (web app), minimal form
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

The real site keys everything on `KEY_BY_CODE` in `src/lib/electronViolations.js`, which also treats `neverHardBlock` codes as strikes or log-only whatever `isHardBlock` says.

## Violation payload

`onViolation` and `POST /interview/violation` get the same object:

```jsonc
{
  "id": "0b6f3c1e-8f5d-4a52-9a41-7d2e6c9b1f03", // UUID, acknowledge with it
  "code": "blocked_app", // what happened: key your handling and copy on this
  "category": "meeting", // the check that raised it, or null
  "apps": ["Zoom", "Microsoft Teams"], // display names, may be empty
  "event": "Blocked application running during interview: Zoom, Microsoft Teams",
  "severity": "high", // "high" | "medium"
  "count": 1, // times this event text has fired this session
  "isHardBlock": true, // high severity, or count >= 2; always false for neverHardBlock codes
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

## Codes

From `src/shared/violationCodes.js`. "Never hard" codes are `STRIKE_CODES` there, and `neverHardBlock: true` in the contract.

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
| `virtual_camera`      | Agent: a virtual camera (OBS Virtual Camera, ManyCam, …) is feeding video; installed alone doesn't count                                               | Soft; hard on repeat      |
| `suspicious_activity` | Any other agent finding (window titles, modules, network, automation, virtual audio), or an event without its own code (deep‑link swap)                | Follow `isHardBlock`      |
| `agent_unreachable`   | The security agent didn't answer, or couldn't finish its checks, 3 times in a row: it may have been killed                                             | Hard                      |
| `check_unverified`    | The display (`hdmi`) or process (`null`) check couldn't answer 3 times in a row                                                                        | Hard                      |
| `window_minimize`     | The candidate tried to minimize the window (undone)                                                                                                    | Hard                      |
| `fullscreen_exit`     | The candidate left fullscreen (undone)                                                                                                                 | Soft; hard on repeat      |
| `close_attempt`       | The candidate opened the exit dialog and cancelled it                                                                                                  | Hard                      |
| `focus_lost`          | Another app came to the front (Windows: its name is in `apps`). Electron brings the interview back; the site's own focus tracking already strikes this | Site decides (never hard) |
| `virtual_desktop`     | Windows: the interview window is no longer on the current virtual desktop                                                                              | Site decides (never hard) |

Every agent threat code in a scan is sent, not only the first. Threats sharing a code are one violation, with all their apps.

## Acknowledgement and redelivery

Call `acknowledgeViolation(payload.id)` first thing in the handler. Without an id it acknowledges everything pending, which is what builds from before ids do.

- Electron keeps every violation, soft and hard, until it is acknowledged: the newest 20 (`MAX_UNACKED_VIOLATIONS`), oldest dropped first.
- Each time the interview page finishes loading, all of them are sent again, in order, with the same `id` and `redelivered: true`.
- An unacknowledged hard block is also sent once more after 8s (`HARD_BLOCK_GRACE_MS`).
- A redelivery is the same violation, not a new one: dedupe on `id` so it doesn't count twice toward a termination threshold. The backend gets each violation once (queued and retried), with the same `id`.
- None of this touches the lockdown: only `interviewComplete()` or a confirmed exit unlocks the window.

> If the web app doesn't call `acknowledgeViolation()`, every violation is sent again on each page load, and each hard block once more after 8s. The lockdown is unaffected either way.

## Ending, aborting, leaving

When the site decides the session is over (normal finish, or terminate after N violations):

```js
window.electronAPI.interviewComplete("terminated"); // "completed" | "auto-submitted" | "terminated" | "expired"
```

When the interview can't start (no attempts left, the start request fails), send the candidate back. It is refused once `startProctoring()` has been called:

```js
window.electronAPI.abortInterview("attempts-exhausted"); // any other reason shows "couldn't start" on the dashboard
```

The reasons the site sends today are listed under `reasons` in the contract. The app keeps only `[\w:-]`, cuts to 40 characters and logs the result; only `attempts-exhausted` changes what the dashboard shows.

When the scorecard's "View Dashboard" button is pressed (still on the interview origin: `interviewComplete` lifted the lockdown but did not navigate away):

```js
window.electronAPI.viewDashboard?.();
```

It is ignored until the lockdown has been released.

## Recording failures

Screen/mic recording runs independently of the violation pipeline. It can fail (no screen source, blocked getUserMedia, upload session never established) without the interview itself being blocked. Electron does not stop the session on a recording failure; that is the web app's call, which is why listening for it is required:

```js
window.electronAPI.onProctoringError?.(({ error }) => {
  // Recording is not being captured. Flag for review, warn the candidate, or show the error.
});
```

If the web app never registers this listener, a candidate can complete an entire interview with zero recorded footage and nobody is told.

## sessionStorage handoff

Before the interview SPA's first render, Electron injects these keys into its `sessionStorage` on `dom-ready` (`windowManager.js#lockdownForInterview`). It also removes `interview_session`, `face_registered` and `face_registered_for` left over from an earlier interview in the same window.

| Key               | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `ac` / `rc`       | Access / refresh token, when a session is available                                                      |
| `candidate_photo` | Base64 data URL of the live photo captured during identity verification                                  |
| `role_selection`  | JSON-encoded `{ is_custom_role, selected_role?, manual_skills? }`                                        |
| `locale`          | The candidate's chosen UI language (e.g. `"hi"`). Secondary channel: prefer the `lang` query param below |

The `lang` query param on the interview URL carries the same value and is available before the SPA's first script runs, so prefer it over `sessionStorage.locale` at boot: `dom-ready` can fire after a module-script SPA has already started.

The interview window's user agent ends in `LetsHyreSecureInterview/<version>`. The site uses it to refuse app versions older than `VITE_MIN_DESKTOP_VERSION`.

## Deep link protocol

Registered scheme: **`letshyre://`**

```
letshyre://start?ac=<accessToken>&rc=<refreshToken>
```

`ac` (access) and `rc` (refresh) are parsed in `src/main/protocolHandler.js`, used to build the interview URL and to authenticate backend calls. A protocol activation **during** an active interview is treated as a high‑severity violation (possible session swap).

The interview URL also carries the candidate's chosen language as `lang` (e.g. `te`), attached on every read rather than baked in at build time: the language-selection page runs after the URL is first assembled.

```
https://interview.letshyre.com/?ac=<accessToken>&rc=<refreshToken>&lang=<localeCode>
```

Packaged builds only ever emit a certified (`reviewed: true`) locale, so `lang` stays `en` there until a translation is certified. All 19 codes appear in dev/QA builds.

## Support details

`getSupportContact()` resolves `{ url, email, referenceCode }` for a help screen. `url` and `email` come from `SUPPORT_URL` / `SUPPORT_EMAIL` and are `null` when unset. `referenceCode` (`LH-XXXX-XXXX`) is what the candidate quotes to support; the app logs it, and shows the same code on its "Can't reach your interview" page and on the dashboard after a failed start. After `startProctoring({ sessionId })` it is the first 40 bits of `sha256(sessionId)` in RFC 4648 base32, so the backend can derive it too; before that it comes from a random id for the attempt.

## Renderer API (`window.electronAPI`)

Exposed by `preload.js` via `contextBridge` (only whitelisted channels). Safe to call in a plain browser: methods no‑op if `electronAPI` is absent. The same API is exposed to the local pages and the interview site, but main enforces who may call what (`ipcScope.js`). The interview site can only use the methods in `electronAPI.methods` of the contract; the rest are for the local pages.

| Method                                                                                              | Purpose                                                                                                          | Site may call |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------- |
| `onViolation(cb)` / `removeViolationListener()`                                                     | Receive violations during the interview                                                                          | yes           |
| `acknowledgeViolation(id)`                                                                          | Confirm receipt of that violation so it isn't sent again; without an `id`, acknowledges everything pending       | yes           |
| `interviewComplete(reason)`                                                                         | End the session; lifts the lockdown                                                                              | yes           |
| `abortInterview(reason)`                                                                            | The interview couldn't start; releases the lockdown and goes back to the dashboard (refused once it has started) | yes           |
| `viewDashboard()`                                                                                   | Scorecard "View Dashboard" button; leaves for the dashboard once the lockdown is released                        | yes           |
| `startProctoring(meta)` / `stopProctoring()` / `onProctoringStarted(cb)`                            | Start/stop the screen recording                                                                                  | yes           |
| `onProctoringError(cb)`                                                                             | Recording failed (see [Recording failures](#recording-failures))                                                 | yes           |
| `runPreflight()`                                                                                    | Run all preflight scans; resolves with `{ hdmi, mirror, agent }`                                                 | no            |
| `onPreflightProgress(cb)` / `removePreflightProgressListener()`                                     | Per‑step streaming progress                                                                                      | no            |
| `onPreProceedStatus(cb)` / `removePreProceedStatusListener()`                                       | Live blocked‑app status on the success screen                                                                    | no            |
| `proceedToInterview()`                                                                              | Enter lockdown and load the interview                                                                            | no            |
| `killProcess(name)` / `killAllProcesses(names)`                                                     | Force‑close a blocked app (whitelisted); see [detection.md](detection.md#closing-blocked-apps)                   | no            |
| `canElevate()` / `killProcessElevated(name)`                                                        | Whether the user is an admin; one‑shot elevated retry (refused during an interview)                              | no            |
| `recheckSystem()` / `minimizeWindow()` / `quitApp()`                                                | Preflight UX controls                                                                                            | no            |
| `getSupportContact()`                                                                               | Interview site: `{ url, email, referenceCode }` for its help screens (read-only)                                             |
| `getSupportInfo()` / `openSupport()`                                                                | Local pages: whether a support link is set, the reference code; open the link                                                |
| `startPracticeCheck()`                                                                              | Dashboard "Check my computer": the security check alone; Continue is refused and nothing is locked down                      |
| `retryInterview()`                                                                                  | Reload the interview from the "Can't reach your interview" page                                                  | no            |
| `getAppList()` / `getAuditLog()`                                                                    | Blocked‑app lists; in‑memory audit log                                                                           | no            |
| `onUpdateAvailable` / `onUpdateProgress` / `onUpdateDownloaded` / `onUpdateError` / `onUpdateState` | Auto‑updater events (used by `updateCard.js`)                                                                    | no            |
| `getUpdateState()` / `installUpdate()` / `getAppVersion()`                                          | Current updater snapshot; quit and install; running version                                                      | no            |
| `login` / `logout` / `getAuthUser` / `getCandidateProfile`                                          | Sign‑in and dashboard                                                                                            | no            |
| `startInterview` / `load…Page` / `submitRole` / `submitFaceVerification` / `submitVoiceSample`      | Local page flow from the dashboard to the interview                                                              | no            |
| `getLocale` / `setLocale` / `getTranslations` / `onLocaleChanged`                                   | UI language                                                                                                      | no            |
