/**
 * Trust-boundary enforcement for ipcMain registrations.
 *
 * windowManager.js reuses a single BrowserWindow/webContents for both the
 * local file:// pages (login, preflight, permissions, …) and, after
 * lockdownForInterview(), the remote interview site — same preload, same
 * window.electronAPI. Nothing about ipcMain distinguishes those two callers
 * on its own, so every registration here must declare which one it trusts.
 *
 * Scope is a REQUIRED third argument to registerHandler()/registerSend() —
 * not a lookup into a separate map — so a new channel added later without
 * picking "local" or "interview" throws immediately instead of quietly
 * inheriting an open default.
 */

"use strict";

const { ipcMain } = require("electron");
const logger = require("./logger");
const { INTERVIEW_BASE_URL } = require("../shared/constants");

const SCOPE = Object.freeze({ LOCAL: "local", INTERVIEW: "interview" });

const INTERVIEW_ORIGIN = new URL(INTERVIEW_BASE_URL).origin;

// Pages with no scheme/host/port triple (file://) get Chromium's opaque
// origin, serialised per RFC 6454 as the literal string "null" — confirmed
// against WebFrameMain#origin's doc comment in this app's installed Electron
// version (node_modules/electron/electron.d.ts, 30.5.1) and against Node's
// own URL parser, which serialises file:// origins the same way.
const LOCAL_ORIGIN = "null";

/**
 * Pure predicate: does `origin` satisfy `scope`? No Electron objects
 * involved — testable under plain Node.
 * @param {"local"|"interview"} scope
 * @param {string} origin
 */
function isOriginAllowed(scope, origin) {
  if (scope === SCOPE.LOCAL) {
    return origin === LOCAL_ORIGIN;
  }
  if (scope === SCOPE.INTERVIEW) {
    return origin === INTERVIEW_ORIGIN;
  }
  throw new Error(`ipcScope: unknown scope "${scope}"`);
}

/**
 * A WebFrameMain's own `top` is itself for the top frame (there is no parent
 * to point at) — so both "top === frame" and a nullish top count as
 * top-level. Nested iframes are refused for every scope: the documented web
 * app contract is framework-level and never needs a sub-frame to reach it.
 * @param {{ top?: unknown }} frame
 */
function isTopFrame(frame) {
  return frame.top === frame || frame.top === null || frame.top === undefined;
}

/**
 * Pure predicate over a frame-shaped object ({ origin, top }). Accepts a
 * real Electron WebFrameMain or a plain test double with the same shape.
 * @param {"local"|"interview"} scope
 * @param {{ origin?: unknown, top?: unknown } | null | undefined} frame
 */
function isFrameAllowed(scope, frame) {
  if (!frame || typeof frame.origin !== "string") {
    return false;
  }
  return isTopFrame(frame) && isOriginAllowed(scope, frame.origin);
}

/**
 * Same check as isFrameAllowed(), starting from a URL string instead of a
 * WebFrameMain — for handlers (setPermissionRequestHandler) whose Electron
 * API hands back a requesting URL rather than a frame reference.
 * @param {"local"|"interview"} scope
 * @param {string} url
 */
function isUrlOriginAllowed(scope, url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return isOriginAllowed(scope, origin);
}

function _describeFrame(frame) {
  return frame && typeof frame.origin === "string" ? frame.origin : "(no frame)";
}

function _assertValidScope(fnName, channel, scope) {
  if (scope !== SCOPE.LOCAL && scope !== SCOPE.INTERVIEW) {
    throw new Error(
      `ipcScope.${fnName}: channel "${channel}" needs scope "local" or "interview", got ${JSON.stringify(scope)}`
    );
  }
}

/**
 * Wraps ipcMain.handle() so a scope must be declared at registration time.
 * A sender that fails the scope check gets its invoke() rejected (thrown
 * errors inside an ipcMain.handle callback become renderer-side promise
 * rejections automatically) rather than silently reaching the real handler.
 * @param {string} channel
 * @param {"local"|"interview"} scope
 * @param {(event: import('electron').IpcMainInvokeEvent, ...args: any[]) => any} handler
 */
function registerHandler(channel, scope, handler) {
  _assertValidScope("registerHandler", channel, scope);
  ipcMain.handle(channel, (event, ...args) => {
    if (!isFrameAllowed(scope, event.senderFrame)) {
      logger.warn(
        `[ipc-scope] rejected invoke "${channel}" (scope: ${scope}) from origin ${_describeFrame(event.senderFrame)}`
      );
      throw new Error("This action is not permitted from this context.");
    }
    return handler(event, ...args);
  });
}

/**
 * Wraps ipcMain.on() the same way, for fire-and-forget channels. There is no
 * promise to reject, so a failed check just logs and refuses to invoke the
 * real handler.
 * @param {string} channel
 * @param {"local"|"interview"} scope
 * @param {(event: import('electron').IpcMainEvent, ...args: any[]) => any} handler
 */
function registerSend(channel, scope, handler) {
  _assertValidScope("registerSend", channel, scope);
  ipcMain.on(channel, (event, ...args) => {
    if (!isFrameAllowed(scope, event.senderFrame)) {
      logger.warn(
        `[ipc-scope] rejected send "${channel}" (scope: ${scope}) from origin ${_describeFrame(event.senderFrame)}`
      );
      return;
    }
    handler(event, ...args);
  });
}

module.exports = {
  SCOPE,
  INTERVIEW_ORIGIN,
  LOCAL_ORIGIN,
  isOriginAllowed,
  isTopFrame,
  isFrameAllowed,
  isUrlOriginAllowed,
  registerHandler,
  registerSend,
};
