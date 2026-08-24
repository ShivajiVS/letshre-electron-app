/**
 * Centralised registration of ALL ipcMain channels.
 * This is the only file that registers ipcMain handlers, always through
 * ipcScope's registerHandler()/registerSend() so every channel declares a
 * sender scope ("local" | "interview") up front — see ipcScope.js.
 * Channel names come from shared/constants.js — no raw strings here.
 *
 * Call `registerIpcHandlers()` once during app initialisation.
 */

"use strict";

const path = require("path");
const { app } = require("electron");
const updater = require("./updater");
const logger = require("./logger");
const appState = require("./appState");
const { IPC } = require("../shared/constants");
const { SCOPE, registerHandler, registerSend } = require("./ipcScope");
const {
  killSingleProcess,
  killAllProcesses,
  killSingleProcessElevated,
  canElevate,
} = require("./processKiller");
const {
  lockdownForInterview,
  storeCandidatePhoto,
  clearCandidatePhoto,
  clearInterviewSessionData,
  endInterview,
  getWindow,
  minimizeWindow,
  loadDashboard,
  loadSecurityCheck,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
} = require("./windowManager");
const { invalidateProcessCache } = require("../detector/mirrorDetector");
const {
  getCurrentInterviewUrl,
  setInterviewSession,
  resetInterviewSession,
} = require("./protocolHandler");
const { whenAgentReady, killAgent } = require("./agentManager");
const authManager = require("./authManager");
const authValidators = require("../shared/authValidators");
const localeManager = require("./localeManager");
const startDetection = require("../detector/systemChecks");
const screenRecorder = require("./screenRecorder");
const { startPreProceedMonitor, stopPreProceedMonitor } = startDetection;

const {
  MEETING_APPS,
  SCREEN_SHARING_APPS,
  AI_CHEATING_APPS,
  APP_DISPLAY_NAMES,
} = require("../shared/appList");

/**
 * Validates and sanitises a process name coming from the renderer.
 * IMP-03: Prevents type confusion and oversized payloads from reaching processKiller.
 * @param {unknown} value
 * @returns {{ valid: boolean, safe: string }}
 */
function validateProcessName(value) {
  if (typeof value !== "string") {
    return { valid: false, safe: "" };
  }
  if (value.length === 0 || value.length > 120) {
    return { valid: false, safe: "" };
  }
  // Strip anything that isn't alphanumeric, dot, dash, space, or underscore
  const safe = value.replace(/[^\w.\- ]/g, "");
  return { valid: safe.length > 0, safe };
}

/**
 * Fire-and-forget spawn of the security agent as the security-check page opens,
 * so it is warming up before the preflight scan probes it. whenAgentReady() is
 * the single readiness owner — concurrent callers share one spawn and one poll,
 * so this can't race the preflight's own readiness wait.
 */
function prewarmAgent() {
  whenAgentReady().catch((err) => logger.warn("[ipc] agent pre-warm failed:", err.message));
}

// Security-check page generation. Bumped whenever that page's lifecycle
// restarts, so an in-flight scan from a previous visit (whose agent was killed
// on the way out) can never be joined and reported by the new page.
let _pageGeneration = 0;
/** @type {Promise<object> | null} */
let _preflightInFlight = null;
let _preflightGeneration = -1;

/**
 * Sanitises the role-selection payload sent by the role-selection renderer before
 * it is injected into the interview site's sessionStorage. Renderer input is
 * untrusted — coerce types and cap sizes so a malformed/oversized payload can't
 * reach the site or the start-interview API.
 * @param {unknown} payload
 * @returns {{ is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] }}
 */
function sanitizeRoleSelection(payload) {
  const isCustom = payload?.is_custom_role === true;
  if (!isCustom) {
    // Confirmed profile role — the backend resolves the role itself.
    return { is_custom_role: false };
  }
  const toStringArray = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((s) => typeof s === "string")
      .map((s) => s.trim().slice(0, 200))
      .filter((s) => s.length > 0)
      .slice(0, 50);

  const result = { is_custom_role: true };
  const roles = toStringArray(payload?.selected_role);
  const skills = toStringArray(payload?.manual_skills);
  if (roles.length) {
    result.selected_role = roles;
  }
  if (skills.length) {
    result.manual_skills = skills;
  }
  return result;
}

//Registers all IPC handlers. Must be called after app is ready.
function registerIpcHandlers() {
  // Tokens are handled entirely in main (authManager); the renderer only ever
  // receives display-safe user fields.

  // Auth, profile, and navigation channels are all local-only: the candidate
  // authenticates and moves through login/dashboard/preflight entirely on
  // file:// pages, before the window ever navigates to the interview origin.
  registerHandler(IPC.AUTH_LOGIN, SCOPE.LOCAL, async (_event, creds) => {
    // Defensive caps against a pathological paste — well above any real
    // email/password, cheap insurance before this ever reaches axios.
    const email = typeof creds?.email === "string" ? creds.email.trim().slice(0, 254) : "";
    const password = typeof creds?.password === "string" ? creds.password.slice(0, 256) : "";
    if (!email || !password) {
      return { success: false, code: authManager.AUTH_ERROR.MISSING_FIELDS };
    }
    // Backstop, not the primary gate — the renderer already validates before
    // ever calling this. Electron's threat model assumes the renderer can be
    // compromised, so main re-checks rather than trusting it alone. Email
    // shape is safe to reject here (a malformed email can't match a real
    // account either way); password complexity is NOT re-checked — the
    // backend is the actual authority on whether a password is valid for a
    // given account, and rejecting here on a guessed policy risks blocking a
    // real login the server would have accepted.
    if (!authValidators.validateEmail(email).valid) {
      return { success: false, code: authManager.AUTH_ERROR.INVALID_EMAIL };
    }
    logger.info("[ipc] auth-login for", email);
    return await authManager.login(email, password);
  });

  registerHandler(IPC.AUTH_LOGOUT, SCOPE.LOCAL, async () => {
    logger.info("[ipc] auth-logout received");
    const result = await authManager.logout();
    // Wipe all per-user state so the next account starts clean — no stale face
    // photo, interview tokens, or cached interview-site data from the previous
    // candidate. The renderer awaits this before navigating to login.
    clearCandidatePhoto();
    resetInterviewSession();
    await clearInterviewSessionData();
    return result;
  });

  registerHandler(IPC.GET_AUTH_USER, SCOPE.LOCAL, () => authManager.getUser());

  registerHandler(IPC.GET_CANDIDATE_PROFILE, SCOPE.LOCAL, async () => {
    logger.info("[ipc] get-candidate-profile");
    return await authManager.getCandidateProfile();
  });

  // Proxy image through main process — renderer CSP blocks external CDN URLs
  registerHandler(IPC.FETCH_PROFILE_IMAGE, SCOPE.LOCAL, async (_event, url) => {
    return await authManager.fetchProfileImage(url);
  });

  // Dashboard "Take Interview": set the interview session from the logged-in
  // tokens, then hand off to the EXISTING security-check screen.
  registerSend(IPC.START_INTERVIEW, SCOPE.LOCAL, () => {
    const tokens = authManager.getTokens();
    if (!tokens) {
      logger.warn("[ipc] start-interview rejected — not authenticated");
      return;
    }
    logger.info("[ipc] start-interview — entering security check");
    setInterviewSession(tokens.accessToken, tokens.refreshToken);
    _pageGeneration++;
    prewarmAgent();
    loadSecurityCheck();
  });

  // Preflight "Proceed" → load the permissions page (NOT locked down yet;
  // the OS needs to present native mic/camera/screen dialogs).
  registerSend(IPC.LOAD_PERMISSIONS_PAGE, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-permissions-page");

    // Authoritative preflight gate — the renderer enabling its Proceed button
    // is UX only. Re-verify the last scan actually passed and is still fresh,
    // so devtools/a renderer bug can't walk past checks, and a stale pass
    // (green screen, then a blocked app launched) doesn't count as a pass.
    const gate = startDetection.verifyProceedAllowed();
    if (!gate.ok) {
      logger.warn(`[ipc] load-permissions-page REFUSED — ${gate.reason}`);
      loadSecurityCheck(); // bounce back to a fresh scan
      return;
    }
    loadPermissionsPage();
  });

  registerSend(IPC.LOAD_IDENTITY_VERIFICATION, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-identity-verification");
    loadIdentityVerificationPage();
  });

  // Identity verification — voice sample upload (blob arrives as Uint8Array over IPC).
  // meta.locale/statementText tell the backend which language the candidate read
  // the attestation in, so STT/voice-match uses the right language model.
  registerHandler(
    IPC.SUBMIT_VOICE_SAMPLE,
    SCOPE.LOCAL,
    async (_event, uint8Array, mimeType, meta) => {
      logger.info("[ipc] submit-voice-sample");
      return await authManager.submitVoiceSample(uint8Array, mimeType, meta);
    }
  );

  // Identity verification — face photo upload (data URL string).
  registerHandler(IPC.SUBMIT_FACE_VERIFICATION, SCOPE.LOCAL, async (_event, dataUrl) => {
    logger.info("[ipc] submit-face-verification");
    return await authManager.submitFaceVerification(dataUrl);
  });

  registerSend(IPC.LOAD_DASHBOARD, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-dashboard (back nav)");
    stopPreProceedMonitor();
    _pageGeneration++; // leaving the page — any scan still running is orphaned
    // Leaving the security-check → interview flow: stop the agent (it is only
    // needed on the preflight page and during the interview). No-op if already
    // stopped (e.g. after interview completion).
    killAgent();
    loadDashboard();
  });

  registerSend(IPC.LOAD_SECURITY_CHECK, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-security-check (back nav)");
    stopPreProceedMonitor();
    _pageGeneration++;
    prewarmAgent();
    loadSecurityCheck();
  });

  registerSend(IPC.LOAD_ROLE_SELECTION, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-role-selection");
    loadRoleSelectionPage();
  });

  registerSend(IPC.LOAD_HOW_IT_WORKS, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-how-it-works");
    loadHowItWorksPage();
  });

  // Role selection — submit role → get skills or clarification suggestions.
  registerHandler(IPC.SUBMIT_ROLE, SCOPE.LOCAL, async (_event, role) => {
    const safeRole = typeof role === "string" ? role.trim().slice(0, 200) : "";
    if (!safeRole) {
      return { ok: false, error: "Role is required." };
    }
    logger.info("[ipc] submit-role:", safeRole);
    return await authManager.submitRole(safeRole);
  });

  // ── Localization
  // The interview site's locale is never read via this bridge (README/A3: not
  // part of the documented contract — the candidate's locale choice does not
  // currently reach the SPA at all), so these all stay local-only.

  registerHandler(IPC.GET_LOCALE, SCOPE.LOCAL, () => localeManager.getPreferred());

  registerHandler(IPC.GET_SUPPORTED_LOCALES, SCOPE.LOCAL, () =>
    localeManager.getSupportedLocales()
  );

  registerHandler(IPC.GET_TRANSLATIONS, SCOPE.LOCAL, (_event, locale) => {
    const safeLocale = typeof locale === "string" ? locale.slice(0, 20) : undefined;
    return localeManager.getTranslations(safeLocale || localeManager.getPreferred());
  });

  registerHandler(IPC.GET_I18N_BOOTSTRAP, SCOPE.LOCAL, () => localeManager.getBootstrap());

  registerHandler(IPC.SET_LOCALE, SCOPE.LOCAL, async (_event, locale) => {
    const safeLocale = typeof locale === "string" ? locale.slice(0, 20) : "";
    const applied = await localeManager.setPreferred(safeLocale);
    logger.info("[ipc] set-locale:", applied);
    // Broadcast so every open window (there's normally only one, but this is
    // cheap and future-proof) can re-apply translations without a reload.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.LOCALE_CHANGED, applied);
    }
    return applied;
  });

  // ── App Control

  registerHandler(IPC.GET_APP_LIST, SCOPE.LOCAL, () => ({
    meetingApps: MEETING_APPS,
    screenSharingApps: SCREEN_SHARING_APPS,
    aiCheatingApps: AI_CHEATING_APPS,
    displayNames: APP_DISPLAY_NAMES,
  }));

  registerSend(IPC.QUIT_APP, SCOPE.LOCAL, () => {
    logger.info("[ipc] quit-app received");
    appState.setQuitting();
    app.quit();
  });

  // Preflight UX: user can minimize to close other apps manually before rescanning
  registerSend(IPC.MINIMIZE_WINDOW, SCOPE.LOCAL, () => {
    minimizeWindow();
  });

  registerSend(IPC.RECHECK_SYSTEM, SCOPE.LOCAL, () => {
    const win = getWindow();
    if (!win) {
      return;
    }
    logger.info("[ipc] recheck-system received");
    stopPreProceedMonitor();
    invalidateProcessCache();
    if (startDetection.resetState) {
      startDetection.resetState();
    }
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight

  // In-flight preflight, shared by concurrent callers WITHIN one page
  // generation. A renderer-side timeout used to abandon its invoke and
  // immediately fire another, stacking two full scans on top of each other;
  // dedupe fixes that, but only a scan from the current visit may be joined —
  // an older one's agent was killed on the way out to the dashboard.
  registerHandler(IPC.RUN_PREFLIGHT, SCOPE.LOCAL, async (event) => {
    const generation = _pageGeneration;
    if (_preflightInFlight && _preflightGeneration === generation) {
      logger.info("[ipc] run-preflight-scans — joining in-flight scan");
      return await _preflightInFlight;
    }
    logger.info("[ipc] run-preflight-scans invoked");

    // Not awaited — a cold spawn can take up to AGENT_READY_TIMEOUT_MS, which
    // would block the first card. This shares the same readiness promise the
    // agent check awaits, so it can no longer trigger its own spawn or kill.
    whenAgentReady().catch((err) => logger.warn("[ipc] agent readiness failed:", err.message));

    // Streaming preflight: each verdict is pushed the moment its check lands.
    // event.sender.send() is safe to call from within a registerHandler() callback.
    const onProgress = (verdict) => {
      try {
        event.sender.send(IPC.PREFLIGHT_PROGRESS, verdict);
      } catch {
        // Renderer was destroyed before the scan finished — ignore
      }
    };

    const scan = startDetection.runChecksOnce(onProgress).finally(() => {
      // Only clear our own entry — a newer generation may already have claimed it.
      if (_preflightInFlight === scan) {
        _preflightInFlight = null;
      }
    });
    _preflightInFlight = scan;
    _preflightGeneration = generation;

    const result = await scan;

    // Start the background pre-proceed watcher as soon as preflight is done.
    // It polls checkProcesses() every 2s and pushes { clean, apps } to the
    // renderer — this keeps the Proceed button state accurate without any
    // blocking scan at click-time.
    startPreProceedMonitor(getWindow());

    return result;
  });

  // Identity verification: store candidate photo for sessionStorage injection.
  registerHandler(IPC.STORE_CANDIDATE_PHOTO, SCOPE.LOCAL, (_event, dataUrl) => {
    logger.info("[ipc] store-candidate-photo received");
    storeCandidatePhoto(dataUrl);
  });

  // Sent by role-selection.html — still a local file:// page at this point;
  // this IS the call that triggers the navigation to the interview origin,
  // so by definition it can never come from the interview site itself.
  registerSend(IPC.PROCEED_TO_INTERVIEW, SCOPE.LOCAL, (_event, payload) => {
    const roleSelection = sanitizeRoleSelection(payload);
    logger.info("[ipc] proceed-to-interview received", {
      is_custom_role: roleSelection.is_custom_role,
    });

    // Backstop gate, freshness not required — permissions/identity/role
    // selection have legitimately aged the preflight by now, and live
    // detection takes over once the interview starts. Still refuses entry
    // if no preflight ever passed.
    const gate = startDetection.verifyProceedAllowed({ requireFresh: false });
    if (!gate.ok) {
      logger.warn(`[ipc] proceed-to-interview REFUSED — ${gate.reason}`);
      loadSecurityCheck();
      return;
    }

    // Stop the pre-proceed watcher — no longer needed once interview starts.
    stopPreProceedMonitor();

    const tokens = authManager.getTokens();
    const interviewUrl = getCurrentInterviewUrl();
    lockdownForInterview(interviewUrl, tokens, roleSelection);

    try {
      const win = getWindow();
      startDetection.start(win);
    } catch (err) {
      logger.error("[ipc] detection start failed:", err.message);
    }
  });

  registerHandler(IPC.KILL_BLOCKED_APP, SCOPE.LOCAL, async (_event, processName) => {
    // IMP-03: Validate and sanitise before passing to processKiller
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app rejected — invalid processName:", processName);
      // Carries `outcome` like every other path so the renderer has one shape
      // to switch on rather than a special case for the validation reject.
      return {
        success: false,
        outcome: "not-blocked",
        error: "Invalid process name",
        processName: String(processName).slice(0, 40),
      };
    }
    logger.info("[ipc] kill-blocked-app:", safe);
    const result = await killSingleProcess(safe);
    // Drop the 3s process cache so the next scan reflects the kill immediately
    // (otherwise the just-killed app shows as still running until the TTL).
    invalidateProcessCache();
    return result;
  });

  // Phase 5: does the candidate even have an admin account? Offering an elevated
  // retry to a standard user just produces a credential prompt they cannot
  // satisfy, which reads as the app being broken.
  registerHandler(IPC.CAN_ELEVATE, SCOPE.LOCAL, async () => {
    try {
      return await canElevate();
    } catch (err) {
      logger.warn("[ipc] can-elevate probe failed:", err.message);
      return false;
    }
  });

  registerHandler(IPC.KILL_BLOCKED_APP_ELEVATED, SCOPE.LOCAL, async (_event, processName) => {
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app-elevated rejected — invalid processName:", processName);
      return {
        success: false,
        outcome: "not-blocked",
        error: "Invalid process name",
        processName: String(processName).slice(0, 40),
      };
    }

    // Elevation raises a SYSTEM-MODAL consent dialog. During a live interview
    // that would cover the proctored screen and hand the candidate a system
    // surface mid-session, so it is preflight-only — refused outright once the
    // session is active, regardless of what the renderer asks for.
    if (startDetection.isSessionActive?.()) {
      logger.warn("[ipc] kill-blocked-app-elevated REFUSED — interview session is active");
      return {
        success: false,
        outcome: "access-denied",
        error: "Elevation is not available during an interview",
        processName: safe,
      };
    }

    logger.info("[ipc] kill-blocked-app-elevated:", safe);
    const result = await killSingleProcessElevated(safe);
    invalidateProcessCache();
    return result;
  });

  registerHandler(IPC.KILL_ALL_BLOCKED_APPS, SCOPE.LOCAL, async (_event, processNames) => {
    // IMP-03: Validate array input
    if (!Array.isArray(processNames)) {
      logger.warn("[ipc] kill-all-blocked-apps rejected — not an array");
      return [];
    }
    // Every requested name gets one result at its original index — filtering
    // invalid names out before mapping used to shift results onto the wrong
    // app's row, so rejected names report themselves instead of vanishing.
    const validated = processNames.map((n) => ({ ...validateProcessName(n), original: n }));
    const validNames = validated.filter((r) => r.valid).map((r) => r.safe);

    logger.info("[ipc] kill-all-blocked-apps:", validNames);
    const killed = await killAllProcesses(validNames);
    invalidateProcessCache(); // refresh cache so killed apps clear immediately

    // Re-expand to the caller's original shape, in order.
    const byName = new Map(killed.map((r) => [r.processName, r]));
    const results = validated.map((r) =>
      r.valid
        ? byName.get(r.safe) || {
            processName: r.safe,
            success: false,
            outcome: "spawn-error",
            error: "No result returned for this process",
          }
        : {
            processName: String(r.original).slice(0, 40),
            success: false,
            outcome: "not-blocked",
            error: "Invalid process name",
          }
    );
    return results;
  });

  // ── Auto-Updater — updater UI lives on local pages only; the interview
  // site never surfaces update state, so these stay local-only.
  registerSend(IPC.INSTALL_UPDATE, SCOPE.LOCAL, () => {
    logger.info("[ipc] install-update received");
    // Gated internally — refuses during an active interview.
    updater.installUpdate();
  });

  // Renderer pulls the current updater snapshot on load to recover any
  // state/progress events it missed before its listeners were attached.
  registerHandler(IPC.GET_UPDATE_STATE, SCOPE.LOCAL, () => updater.getState());

  // Renderer asks for the running app version (shown in the preflight footer).
  registerHandler(IPC.GET_APP_VERSION, SCOPE.LOCAL, () => app.getVersion());

  // ADD-07: Exposes the in-memory audit log to the renderer (support
  // diagnostics). The audit log records auth/violation/session events —
  // local-only, never the interview site's business.
  registerHandler(IPC.GET_AUDIT_LOG, SCOPE.LOCAL, () => {
    return startDetection.getAuditLog ? startDetection.getAuditLog() : [];
  });

  // Signal sent by interview.letshyre.com when the session ends.

  // Contract channel #2 (README "Web app integration"): the interview site
  // acknowledges every violation so Electron knows the page is alive.
  registerSend(IPC.ACK_VIOLATION, SCOPE.INTERVIEW, () => {
    if (startDetection.acknowledgeViolation) {
      startDetection.acknowledgeViolation();
    }
  });

  // Contract channel #3: the interview site signals the session is over.
  registerSend(IPC.INTERVIEW_COMPLETE, SCOPE.INTERVIEW, (_event, { reason } = {}) => {
    const safeReason = typeof reason === "string" ? reason.slice(0, 40) : "unknown";
    logger.info(`[ipc] interview-complete received — reason: ${safeReason}`);

    if (startDetection.stop) {
      startDetection.stop();
    }

    // Interview is over — stop the security agent (deep detection is done; the
    // post-interview recording uses desktopCapturer, not the agent).
    killAgent();

    // Recording continues until the site sends PROCTORING_STOP (after the
    // scorecard or termination screen has rendered). Stopping here would cut
    // the video before the candidate sees their result.

    // Lift window lockdown (allows close, minimize, etc.)
    endInterview(safeReason);

    // Safe moment to surface any held update / re-check.
    updater.onInterviewEnded();
  });

  // Register internal recorder↔main IPC (recorder:ready, recorder:chunk, recorder:error).
  screenRecorder.registerRecorderIpc();

  // interview.letshyre.com → start recording
  registerHandler(IPC.PROCTORING_START, SCOPE.INTERVIEW, async (_event, meta = {}) => {
    const safeSessionId = typeof meta?.sessionId === "string" ? meta.sessionId.slice(0, 100) : null;
    const safeInterviewId =
      typeof meta?.interviewId === "string" ? meta.interviewId.slice(0, 100) : null;
    logger.info("[ipc] proctoring-start", {
      sessionId: safeSessionId,
      interviewId: safeInterviewId,
    });
    return await screenRecorder.start({ sessionId: safeSessionId, interviewId: safeInterviewId });
  });

  // interview.letshyre.com → stop recording
  registerSend(IPC.PROCTORING_STOP, SCOPE.INTERVIEW, () => {
    logger.info("[ipc] proctoring-stop");
    screenRecorder.stop();
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
