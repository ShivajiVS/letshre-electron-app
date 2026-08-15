/**
 * src/main/ipcHandlers.js
 * ───────────────────────
 * Centralised registration of ALL ipcMain channels.
 *
 * This is the only file that calls ipcMain.handle() or ipcMain.on().
 * Channel names come from shared/constants.js — no raw strings here.
 *
 * Call `registerIpcHandlers()` once during app initialisation.
 */

"use strict";

const path = require("path");
const { ipcMain, app } = require("electron");
const updater = require("./updater");
const logger = require("./logger");
const appState = require("./appState");
const { IPC } = require("../shared/constants");
const { killSingleProcess, killAllProcesses } = require("./processKiller");
const { lockdownForInterview, storeCandidatePhoto, clearCandidatePhoto, clearInterviewSessionData, endInterview, getWindow, minimizeWindow, loadDashboard, loadSecurityCheck, loadPermissionsPage, loadIdentityVerificationPage, loadRoleSelectionPage, loadHowItWorksPage } = require("./windowManager");
const { invalidateProcessCache } = require("../detector/mirrorDetector");
const { getCurrentInterviewUrl, setInterviewSession, resetInterviewSession } = require("./protocolHandler");
const { ensureAgent, killAgent } = require("./agentManager");
const authManager = require("./authManager");
const localeManager = require("./localeManager");
const startDetection = require("../detector/systemChecks");
const screenRecorder = require("./screenRecorder");
const { startPreProceedMonitor, stopPreProceedMonitor } = startDetection;

const { MEETING_APPS, SCREEN_SHARING_APPS, AI_CHEATING_APPS, APP_DISPLAY_NAMES } = require("../shared/appList");

// ─── Input validation ─────────────────────────────────────────────────────────

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
 * so it is warming up before the preflight scan pings it. ensureAgent() is
 * idempotent (pings first, spawns only if dead) and spawnAgent() guards against
 * concurrent spawns, so this never races the RUN_PREFLIGHT ensureAgent().
 */
function prewarmAgent() {
  ensureAgent().catch((err) =>
    logger.warn("[ipc] agent pre-warm failed:", err.message)
  );
}

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
  if (roles.length) { result.selected_role = roles; }
  if (skills.length) { result.manual_skills = skills; }
  return result;
}

// ─── Handler Registration ─────────────────────────────────────────────────────

/**
 * Registers all IPC handlers. Must be called after app is ready.
 */
function registerIpcHandlers() {
  // ── Auth ───────────────────────────────────────────────────────────────────
  // Tokens are handled entirely in main (authManager); the renderer only ever
  // receives display-safe user fields.

  ipcMain.handle(IPC.AUTH_LOGIN, async (_event, creds) => {
    const email = typeof creds?.email === "string" ? creds.email.trim() : "";
    const password = typeof creds?.password === "string" ? creds.password : "";
    if (!email || !password) {
      return { success: false, message: "Email and password are required." };
    }
    logger.info("[ipc] auth-login for", email);
    return await authManager.login(email, password);
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
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

  ipcMain.handle(IPC.GET_AUTH_USER, () => authManager.getUser());

  ipcMain.handle(IPC.GET_CANDIDATE_PROFILE, async () => {
    logger.info("[ipc] get-candidate-profile");
    return await authManager.getCandidateProfile();
  });

  // Proxy image through main process — renderer CSP blocks external CDN URLs
  ipcMain.handle(IPC.FETCH_PROFILE_IMAGE, async (_event, url) => {
    return await authManager.fetchProfileImage(url);
  });

  // Dashboard "Take Interview": set the interview session from the logged-in
  // tokens, then hand off to the EXISTING security-check screen.
  ipcMain.on(IPC.START_INTERVIEW, () => {
    const tokens = authManager.getTokens();
    if (!tokens) {
      logger.warn("[ipc] start-interview rejected — not authenticated");
      return;
    }
    logger.info("[ipc] start-interview — entering security check");
    setInterviewSession(tokens.accessToken, tokens.refreshToken);
    prewarmAgent(); // start the agent as the security-check page opens
    loadSecurityCheck();
  });

  // Preflight "Proceed" → load the permissions page (NOT locked down yet;
  // the OS needs to present native mic/camera/screen dialogs).
  ipcMain.on(IPC.LOAD_PERMISSIONS_PAGE, () => {
    logger.info("[ipc] load-permissions-page");

    // This is the security-check page's Proceed button — the authoritative
    // preflight gate. The renderer enabling its own button is UX only; main
    // re-verifies that the last scan actually passed and is still fresh, so a
    // renderer bug (or devtools) cannot walk past every check. A stale pass is
    // treated as no pass: the candidate cannot sit on a green screen, launch a
    // blocked app, and then continue.
    const gate = startDetection.verifyProceedAllowed();
    if (!gate.ok) {
      logger.warn(`[ipc] load-permissions-page REFUSED — ${gate.reason}`);
      loadSecurityCheck(); // bounce back to a fresh scan
      return;
    }
    loadPermissionsPage();
  });

  // Permissions "Start interview" → load identity verification page.
  ipcMain.on(IPC.LOAD_IDENTITY_VERIFICATION, () => {
    logger.info("[ipc] load-identity-verification");
    loadIdentityVerificationPage();
  });

  // Identity verification — voice sample upload (blob arrives as Uint8Array over IPC).
  // meta.locale/statementText tell the backend which language the candidate read
  // the attestation in, so STT/voice-match uses the right language model.
  ipcMain.handle(IPC.SUBMIT_VOICE_SAMPLE, async (_event, uint8Array, mimeType, meta) => {
    logger.info("[ipc] submit-voice-sample");
    return await authManager.submitVoiceSample(uint8Array, mimeType, meta);
  });

  // Identity verification — face photo upload (data URL string).
  ipcMain.handle(IPC.SUBMIT_FACE_VERIFICATION, async (_event, dataUrl) => {
    logger.info("[ipc] submit-face-verification");
    return await authManager.submitFaceVerification(dataUrl);
  });

  // Back navigation
  ipcMain.on(IPC.LOAD_DASHBOARD, () => {
    logger.info("[ipc] load-dashboard (back nav)");
    stopPreProceedMonitor();
    // Leaving the security-check → interview flow: stop the agent (it is only
    // needed on the preflight page and during the interview). No-op if already
    // stopped (e.g. after interview completion).
    killAgent();
    loadDashboard();
  });

  ipcMain.on(IPC.LOAD_SECURITY_CHECK, () => {
    logger.info("[ipc] load-security-check (back nav)");
    stopPreProceedMonitor();
    prewarmAgent(); // returning to the security-check page — restart the agent
    loadSecurityCheck();
  });

  // Role selection page navigation.
  ipcMain.on(IPC.LOAD_ROLE_SELECTION, () => {
    logger.info("[ipc] load-role-selection");
    loadRoleSelectionPage();
  });

  // How-it-works page navigation.
  ipcMain.on(IPC.LOAD_HOW_IT_WORKS, () => {
    logger.info("[ipc] load-how-it-works");
    loadHowItWorksPage();
  });

  // Role selection — submit role → get skills or clarification suggestions.
  ipcMain.handle(IPC.SUBMIT_ROLE, async (_event, role) => {
    const safeRole = typeof role === "string" ? role.trim().slice(0, 200) : "";
    if (!safeRole) { return { ok: false, error: "Role is required." }; }
    logger.info("[ipc] submit-role:", safeRole);
    return await authManager.submitRole(safeRole);
  });

  // ── Localization ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_LOCALE, () => localeManager.getPreferred());

  ipcMain.handle(IPC.GET_SUPPORTED_LOCALES, () => localeManager.getSupportedLocales());

  ipcMain.handle(IPC.GET_TRANSLATIONS, (_event, locale) => {
    const safeLocale = typeof locale === "string" ? locale.slice(0, 20) : undefined;
    return localeManager.getTranslations(safeLocale || localeManager.getPreferred());
  });

  ipcMain.handle(IPC.SET_LOCALE, (_event, locale) => {
    const safeLocale = typeof locale === "string" ? locale.slice(0, 20) : "";
    const applied = localeManager.setPreferred(safeLocale);
    logger.info("[ipc] set-locale:", applied);
    // Broadcast so every open window (there's normally only one, but this is
    // cheap and future-proof) can re-apply translations without a reload.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.LOCALE_CHANGED, applied);
    }
    return applied;
  });

  // ── App Control ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_APP_LIST, () => ({
    meetingApps: MEETING_APPS,
    screenSharingApps: SCREEN_SHARING_APPS,
    aiCheatingApps: AI_CHEATING_APPS,
    displayNames: APP_DISPLAY_NAMES,
  }));

  ipcMain.on(IPC.QUIT_APP, () => {
    logger.info("[ipc] quit-app received");
    appState.setQuitting();
    app.quit();
  });

  // Preflight UX: user can minimize to close other apps manually before rescanning
  ipcMain.on(IPC.MINIMIZE_WINDOW, () => {
    minimizeWindow();
  });

  ipcMain.on(IPC.RECHECK_SYSTEM, () => {
    const win = getWindow();
    if (!win) { return; }
    logger.info("[ipc] recheck-system received");
    stopPreProceedMonitor();
    invalidateProcessCache();
    if (startDetection.resetState) { startDetection.resetState(); }
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight ────────────────────────────────────────────────────────────

  // In-flight preflight, shared by concurrent callers. A renderer-side timeout
  // used to abandon its invoke and immediately fire another, stacking two full
  // scans (and two agent respawns) on top of each other while the abandoned
  // one's progress events still repainted the new scan's cards.
  let _preflightInFlight = null;

  ipcMain.handle(IPC.RUN_PREFLIGHT, async (event) => {
    if (_preflightInFlight) {
      logger.info("[ipc] run-preflight-scans — joining in-flight scan");
      return await _preflightInFlight;
    }
    logger.info("[ipc] run-preflight-scans invoked");

    // NOTE: ensureAgent() is deliberately NOT awaited here. It can block for up
    // to AGENT_PING_TIMEOUT_MS (15s) waiting on a cold spawn, which used to run
    // BEFORE the first card could resolve and blew the renderer's scan budget on
    // slow machines. The agent is pre-warmed when the page loads (prewarmAgent),
    // and a still-unavailable agent now degrades to a single "unverified" agent
    // card while the other five checks resolve normally. We still kick a
    // self-heal off in the background so the next Re-scan finds it alive.
    ensureAgent().catch((err) => logger.warn("[ipc] ensureAgent failed:", err.message));

    // Streaming preflight: each verdict is pushed the moment its check lands.
    // event.sender.send() is safe to call from within an ipcMain.handle() handler.
    const onProgress = (verdict) => {
      try {
        event.sender.send(IPC.PREFLIGHT_PROGRESS, verdict);
      } catch {
        // Renderer was destroyed before the scan finished — ignore
      }
    };

    _preflightInFlight = startDetection
      .runChecksOnce(onProgress)
      .finally(() => {
        _preflightInFlight = null;
      });

    const result = await _preflightInFlight;

    // Start the background pre-proceed watcher as soon as preflight is done.
    // It polls checkProcesses() every 2s and pushes { clean, apps } to the
    // renderer — this keeps the Proceed button state accurate without any
    // blocking scan at click-time.
    startPreProceedMonitor(getWindow());

    return result;
  });

  // Identity verification: store candidate photo for sessionStorage injection.
  ipcMain.handle(IPC.STORE_CANDIDATE_PHOTO, (_event, dataUrl) => {
    logger.info("[ipc] store-candidate-photo received");
    storeCandidatePhoto(dataUrl);
  });

  //Interview Flow
  ipcMain.on(IPC.PROCEED_TO_INTERVIEW, (_event, payload) => {
    const roleSelection = sanitizeRoleSelection(payload);
    logger.info("[ipc] proceed-to-interview received", { is_custom_role: roleSelection.is_custom_role });

    // Backstop gate. Freshness is NOT required here — the candidate has since
    // walked through permissions, identity verification and role selection, so
    // the preflight is legitimately minutes old by now, and live detection takes
    // over the moment the interview starts. What we still refuse is entering the
    // interview when no preflight ever passed.
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

  //Process Management 
  ipcMain.handle(IPC.KILL_BLOCKED_APP, async (_event, processName) => {
    // IMP-03: Validate and sanitise before passing to processKiller
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app rejected — invalid processName:", processName);
      return { success: false, error: "Invalid process name", processName: String(processName).slice(0, 40) };
    }
    logger.info("[ipc] kill-blocked-app:", safe);
    const result = await killSingleProcess(safe);
    // Drop the 3s process cache so the next scan reflects the kill immediately
    // (otherwise the just-killed app shows as still running until the TTL).
    invalidateProcessCache();
    return result;
  });

  ipcMain.handle(IPC.KILL_ALL_BLOCKED_APPS, async (_event, processNames) => {
    // IMP-03: Validate array input
    if (!Array.isArray(processNames)) {
      logger.warn("[ipc] kill-all-blocked-apps rejected — not an array");
      return [];
    }
    const validNames = processNames
      .map((n) => validateProcessName(n))
      .filter((r) => r.valid)
      .map((r) => r.safe);

    logger.info("[ipc] kill-all-blocked-apps:", validNames);
    const results = await killAllProcesses(validNames);
    invalidateProcessCache(); // refresh cache so killed apps clear immediately
    return results;
  });

  // ── Auto-Updater ─────────────────────────────────────────────────────────
  //Renderer can trigger install after update-downloaded event.

  ipcMain.on(IPC.INSTALL_UPDATE, () => {
    logger.info("[ipc] install-update received");
    // Gated internally — refuses during an active interview.
    updater.installUpdate();
  });

  // Renderer pulls the current updater snapshot on load to recover any
  // state/progress events it missed before its listeners were attached.
  ipcMain.handle(IPC.GET_UPDATE_STATE, () => updater.getState());

  // Renderer asks for the running app version (shown in the preflight footer).
  ipcMain.handle(IPC.GET_APP_VERSION, () => app.getVersion());

  //Audit Trail
  // ADD-07: Exposes the in-memory audit log to the renderer (support diagnostics).

  ipcMain.handle(IPC.GET_AUDIT_LOG, () => {
    return startDetection.getAuditLog ? startDetection.getAuditLog() : [];
  });

  //Interview Complete
  // Signal sent by interview.letshyre.com when the session ends.
  // Stops all detection loops and lifts the window lockdown.

  // Renderer acknowledges it received & is handling a violation — keeps the
  // self-enforcement failsafe suppressed while the website stays responsive.
  ipcMain.on(IPC.ACK_VIOLATION, () => {
    if (startDetection.acknowledgeViolation) {
      startDetection.acknowledgeViolation();
    }
  });

  ipcMain.on(IPC.INTERVIEW_COMPLETE, (_event, { reason } = {}) => {
    const safeReason = typeof reason === "string" ? reason.slice(0, 40) : "unknown";
    logger.info(`[ipc] interview-complete received — reason: ${safeReason}`);

    // Stop all active detection / polling loops
    if (startDetection.stop) { startDetection.stop(); }

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

  // ── Screen recording / proctoring ────────────────────────────────────────
  // Register internal recorder↔main IPC (recorder:ready, recorder:chunk, recorder:error).
  screenRecorder.registerRecorderIpc();

  // interview.letshyre.com → start recording
  ipcMain.handle(IPC.PROCTORING_START, async (_event, meta = {}) => {
    const safeSessionId   = typeof meta?.sessionId   === "string" ? meta.sessionId.slice(0, 100)   : null;
    const safeInterviewId = typeof meta?.interviewId === "string" ? meta.interviewId.slice(0, 100) : null;
    logger.info("[ipc] proctoring-start", { sessionId: safeSessionId, interviewId: safeInterviewId });
    return await screenRecorder.start({ sessionId: safeSessionId, interviewId: safeInterviewId });
  });

  // interview.letshyre.com → stop recording
  ipcMain.on(IPC.PROCTORING_STOP, () => {
    logger.info("[ipc] proctoring-stop");
    screenRecorder.stop();
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
