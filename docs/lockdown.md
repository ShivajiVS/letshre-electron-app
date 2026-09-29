# Interview lockdown

How the app keeps the candidate inside the interview window, and how it lets them out.

The interview runs in **its own window**, created already locked: frameless, kiosk, fullscreen, always‑on‑top (`screen-saver` level), not minimizable, maximizable, resizable or movable. On macOS it uses simple fullscreen, so it never gets a Space of its own. The app window hides meanwhile and comes back on the dashboard once the interview window closes. Locking a framed, maximized window at runtime didn't always stick (display scaling, several monitors), which is why it is built locked. See [decisions/interview-window-built-locked.md](decisions/interview-window-built-locked.md).

A window can only hold its own state, and the escapes that matter are the OS shell's: system keys, the taskbar, Task View, virtual desktops, touchpad gestures, other displays. Each part below covers one of them.

| Part                         | File                                  |
| ---------------------------- | ------------------------------------- |
| Creating the locked window   | `src/main/windowManager.js`           |
| Holding the window's lock    | `src/main/lockdownGuard.js`           |
| System keys, focus, touchpad | `src/main/osLockdown.js` + `agent.py` |
| Other displays               | `src/main/displayShields.js`          |
| Interview never starts       | `src/main/startWatchdog.js`           |
| Release, abort, the ways out | `src/main/ipcHandlers.js`             |

## What holds the lock

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
- **Can't be blocked by any app:** Ctrl+Alt+Del, Win+L, UAC prompts and the power button. The focus watchdog reports what they leave behind.

## When things go wrong

- **Page won't load:** if the interview site is unreachable or answers with a 5xx, the window shows `interview-unavailable.html` ("Can't reach your interview", with **Try again**) and retries after 3s, 5s, 10s, 20s, then every 30s. After three failed loads it also offers **Back to dashboard**, which releases the lockdown. Until then the lockdown stays on, and the session data is injected only into a page that actually loaded.
- **Interview never starts:** if the site hasn't called `startProctoring()` 3 minutes after the lockdown, a dialog asks the candidate to keep waiting or go back to the dashboard, and asks again every 60s (`startWatchdog.js`).
- **Start fails on the site:** the site calls `abortInterview(reason)`. It is refused once `startProctoring()` has been called. See [decisions/abort-refused-once-proctoring-starts.md](decisions/abort-refused-once-proctoring-starts.md).

## Release

The lockdown is released only by:

- `interviewComplete()` from the site,
- `abortInterview()` before the interview starts,
- the two ways back above (unavailable page, start watchdog),
- the candidate confirming the exit dialog,
- or the interview window closing.

`viewDashboard()` is ignored until the lockdown is released. On release, detection stops, the agent hands back the keyboard and touchpad, and only then is the agent stopped (`_releaseInterview` → `windowManager.endInterview` → `killAgent`). A missing violation ack never releases anything.

> Up to 1.4.0 a missing ack made Electron unlock the window and stop detection 8s later. The web app never sent acks, so the first hard block of any interview left a normal window behind. That was the "minimize / maximize / Alt+Tab work in the installed app" report.
