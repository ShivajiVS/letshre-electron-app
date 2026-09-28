# The interview window is built locked

**Decision:** the interview gets its own `BrowserWindow`, created frameless, kiosk, fullscreen and always-on-top, instead of locking the app's normal window at runtime.

**Why:** locking a framed, maximized window after the fact didn't always stick: display scaling and several monitors left it resizable or not quite fullscreen, and a candidate could see and use the taskbar. A window that starts locked has no unlocked state to fall back to.

**What it means in code:**

- `_createInterviewWindow` in `src/main/windowManager.js` builds it; the app window hides until it closes. macOS uses simple fullscreen so the window never gets its own Space.
- `lockdownGuard.js` still re-applies the lock on drift with a 1s watchdog: built locked is the starting point, not a guarantee.
- The OS shell's escapes are handled separately (`osLockdown.js`, `displayShields.js`); see [../lockdown.md](../lockdown.md).
