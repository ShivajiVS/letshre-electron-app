/**
 * The only place ipcMain channels are registered, always through ipcScope so
 * each declares a sender scope. Call registerIpcHandlers() once at startup.
 */

"use strict";

const path = require("path");
const { app, shell } = require("electron");
const updater = require("./updater");
const logger = require("./logger");
const appState = require("./appState");
const { IPC, SUPPORT_URL } = require("../shared/constants");
const { SCOPE, registerHandler, registerSend } = require("./ipcScope");
const {
  killSingleProcess,
  killAllProcesses,
  killSingleProcessElevated,
  killThreatProcess,
  canElevate,
} = require("./processKiller");
const {
  lockdownForInterview,
  retryInterview,
  storeCandidatePhoto,
  clearCandidatePhoto,
  clearInterviewSessionData,
  endInterview,
  getWindow,
  getIsInterviewActive,
  minimizeWindow,
  loadDashboard,
  loadSecurityCheck,
  loadLanguageSelectionPage,
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
const blocklistPolicy = require("./blocklistPolicy");
const { getLists, getDisplayNames } = require("../shared/blocklist");
const { startPreProceedMonitor, stopPreProceedMonitor } = startDetection;

// Longest a scan waits for the company policy fetched at Start Interview.
const POLICY_WAIT_MS = 2000;

/**
 * @param {unknown} value - process name from the renderer
 * @returns {{ valid: boolean, safe: string }}
 */
function validateProcessName(value) {
  if (typeof value !== "string") {
    return { valid: false, safe: "" };
  }
  if (value.length === 0 || value.length > 120) {
    return { valid: false, safe: "" };
  }
  const safe = value.replace(/[^\w.\- ]/g, "");
  return { valid: safe.length > 0, safe };
}

/** @param {unknown} value @returns {string|null} */
function validateScanToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}

/** @returns {string|null} the support link, only when it is a valid https URL */
function supportUrl() {
  try {
    const url = new URL(SUPPORT_URL);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Starts the agent early so it is warm by the time the scan needs it. */
function prewarmAgent() {
  whenAgentReady().catch((err) => logger.warn("[ipc] agent pre-warm failed:", err.message));
}

/** Packaged builds may offer English alone, and a one-option page is a dead end. */
function _languageSelectionIsMeaningful() {
  return localeManager.getSupportedLocales().length > 1;
}

/** Leaves the interview flow for the dashboard and stops the agent. */
function _leaveInterviewFlowToDashboard({ alreadyTornDown = false } = {}) {
  if (!alreadyTornDown) {
    _leaveSecurityCheck();
  }
  killAgent();
  blocklistPolicy.reset();
  loadDashboard();
}

// Bumped every time the security-check page is left or reloaded. A scan from an
// older generation still finishes but can't be joined or commit its result.
let _pageGeneration = 0;
/** @type {{ promise: Promise<object>, generation: number, tokens: Set<string|null> } | null} */
let _preflightInFlight = null;
let _continuing = false;

const BOUNCE_REASONS = { stale: "stale", dirty: "dirty", scanning: "scanning" };

function _leaveSecurityCheck() {
  stopPreProceedMonitor();
  _pageGeneration++;
}

/**
 * Renderer input is untrusted: coerce types and cap sizes before the role
 * selection reaches the interview site.
 * @param {unknown} payload
 * @returns {{ is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] }}
 */
function sanitizeRoleSelection(payload) {
  const isCustom = payload?.is_custom_role === true;
  if (!isCustom) {
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

function registerIpcHandlers() {
  // Tokens stay in main; the renderer only ever gets display-safe user fields.
  registerHandler(IPC.AUTH_LOGIN, SCOPE.LOCAL, async (_event, creds) => {
    const email = typeof creds?.email === "string" ? creds.email.trim().slice(0, 254) : "";
    const password = typeof creds?.password === "string" ? creds.password.slice(0, 256) : "";
    if (!email || !password) {
      return { success: false, code: authManager.AUTH_ERROR.MISSING_FIELDS };
    }
    // Password rules are left to the backend; a guessed policy could block a real login.
    if (!authValidators.validateEmail(email).valid) {
      return { success: false, code: authManager.AUTH_ERROR.INVALID_EMAIL };
    }
    logger.info("[ipc] auth-login for", email);
    return await authManager.login(email, password);
  });

  registerHandler(IPC.AUTH_LOGOUT, SCOPE.LOCAL, async () => {
    logger.info("[ipc] auth-logout received");
    const result = await authManager.logout();
    blocklistPolicy.reset();
    // Nothing of this candidate may carry over to the next account.
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
  // tokens, then hand off to the language step (or straight past it).
  registerSend(IPC.START_INTERVIEW, SCOPE.LOCAL, () => {
    const tokens = authManager.getTokens();
    if (!tokens) {
      logger.warn("[ipc] start-interview rejected — not authenticated");
      return;
    }
    logger.info("[ipc] start-interview — entering security check");
    setInterviewSession(tokens.accessToken, tokens.refreshToken);
    _pageGeneration++;
    blocklistPolicy.loadForInterview(tokens.accessToken);
    // Warm up during language selection rather than on the preflight page.
    prewarmAgent();
    if (_languageSelectionIsMeaningful()) {
      loadLanguageSelectionPage();
    } else {
      loadSecurityCheck();
    }
  });

  // Continue on the security check. Not locked down yet: the OS still has to
  // show its mic/camera/screen prompts on the permissions page.
  // Refusals go back to the page, which confirms in place instead of reloading.
  registerHandler(IPC.LOAD_PERMISSIONS_PAGE, SCOPE.LOCAL, async () => {
    logger.info("[ipc] load-permissions-page");
    if (_continuing) {
      return { ok: false, reason: "scanning" };
    }
    _continuing = true;
    try {
      const generation = _pageGeneration;
      let gate = startDetection.verifyProceedAllowed();
      if (gate.code === "stale") {
        await startDetection.renewStalePass();
        if (_pageGeneration !== generation) {
          return { ok: false, reason: "stale" };
        }
        gate = startDetection.verifyProceedAllowed();
      }
      if (!gate.ok) {
        logger.warn(`[ipc] load-permissions-page REFUSED — ${gate.reason}`);
        return { ok: false, reason: BOUNCE_REASONS[gate.code] || "dirty" };
      }
      _leaveSecurityCheck();
      loadPermissionsPage();
      return { ok: true };
    } catch (err) {
      logger.error("[ipc] load-permissions-page failed:", err.message);
      return { ok: false, reason: "dirty" };
    } finally {
      _continuing = false;
    }
  });

  // Back from identity verification. Skips Proceed's freshness window: the scan
  // already passed this session and Start Interview re-gates on that same basis,
  // so time spent on the voice step must not bounce the candidate to preflight.
  registerSend(IPC.BACK_TO_PERMISSIONS, SCOPE.LOCAL, () => {
    const gate = startDetection.verifyProceedAllowed({ requireFresh: false });
    if (!gate.ok) {
      logger.warn(`[ipc] back-to-permissions REFUSED — ${gate.reason}`);
      loadSecurityCheck();
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

  registerHandler(IPC.SUBMIT_FACE_VERIFICATION, SCOPE.LOCAL, async (_event, dataUrl) => {
    logger.info("[ipc] submit-face-verification");
    return await authManager.submitFaceVerification(dataUrl);
  });

  registerSend(IPC.LOAD_DASHBOARD, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-dashboard (back nav)");
    _leaveInterviewFlowToDashboard();
  });

  registerSend(IPC.VIEW_DASHBOARD, SCOPE.INTERVIEW, () => {
    logger.info("[ipc] view-dashboard (from scorecard)");
    _leaveInterviewFlowToDashboard({ alreadyTornDown: true });
  });

  registerSend(IPC.LOAD_SECURITY_CHECK, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-security-check (back nav)");
    _leaveSecurityCheck();
    prewarmAgent();
    loadSecurityCheck();
  });

  // Back from preflight. The renderer always asks for the language page; when
  // there is nothing to choose it was never shown on the way in either, so
  // falling through to the dashboard is what "back" actually means there.
  registerSend(IPC.LOAD_LANGUAGE_SELECTION, SCOPE.LOCAL, () => {
    _leaveSecurityCheck();
    if (!_languageSelectionIsMeaningful()) {
      logger.info("[ipc] load-language-selection — single locale, going to dashboard");
      _leaveInterviewFlowToDashboard({ alreadyTornDown: true });
      return;
    }
    logger.info("[ipc] load-language-selection (back nav)");
    // The agent stays warm: the candidate is one click from the security check.
    loadLanguageSelectionPage();
  });

  registerSend(IPC.LOAD_ROLE_SELECTION, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-role-selection");
    loadRoleSelectionPage();
  });

  registerSend(IPC.RETRY_INTERVIEW, SCOPE.LOCAL, () => retryInterview());

  registerSend(IPC.LOAD_HOW_IT_WORKS, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-how-it-works");
    loadHowItWorksPage();
  });

  // Role selection — submit role → get skills or clarification suggestions.
  registerHandler(IPC.SUBMIT_ROLE, SCOPE.LOCAL, async (_event, role) => {
    const safeRole = typeof role === "string" ? role.trim().slice(0, 200) : "";
    if (!safeRole) {
      return { ok: false, code: "missing_role" };
    }
    logger.info("[ipc] submit-role:", safeRole);
    return await authManager.submitRole(safeRole);
  });

  // ── Localization

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
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.LOCALE_CHANGED, applied);
    }
    return applied;
  });

  // ── App Control

  registerHandler(IPC.GET_APP_LIST, SCOPE.LOCAL, () => {
    const lists = getLists();
    return {
      meetingApps: lists.meeting,
      screenSharingApps: lists.screen,
      castingApps: lists.wireless,
      browserApps: lists.browser,
      aiCheatingApps: lists.ai,
      displayNames: getDisplayNames(),
    };
  });

  registerSend(IPC.QUIT_APP, SCOPE.LOCAL, () => {
    logger.info("[ipc] quit-app received");
    appState.setQuitting();
    app.quit();
  });

  registerSend(IPC.MINIMIZE_WINDOW, SCOPE.LOCAL, () => {
    minimizeWindow();
  });

  registerSend(IPC.RECHECK_SYSTEM, SCOPE.LOCAL, () => {
    const win = getWindow();
    if (!win) {
      return;
    }
    logger.info("[ipc] recheck-system received");
    _leaveSecurityCheck();
    invalidateProcessCache();
    if (startDetection.resetState) {
      startDetection.resetState();
    }
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  });

  // ── Preflight

  // A second call within the same page generation joins the running scan
  // instead of stacking another one; its token gets the remaining progress.
  registerHandler(IPC.RUN_PREFLIGHT, SCOPE.LOCAL, async (event, rawToken) => {
    const token = validateScanToken(rawToken);
    const generation = _pageGeneration;
    if (_preflightInFlight && _preflightInFlight.generation === generation) {
      logger.info("[ipc] run-preflight-scans — joining in-flight scan");
      _preflightInFlight.tokens.add(token);
      const joined = await _preflightInFlight.promise;
      return { ...joined, token };
    }
    logger.info("[ipc] run-preflight-scans invoked");

    // Not awaited: the agent card waits on the same readiness promise.
    whenAgentReady().catch((err) => logger.warn("[ipc] agent readiness failed:", err.message));

    const tokens = new Set([token]);
    const policyReady = blocklistPolicy.whenSettled(POLICY_WAIT_MS);
    const onProgress = (payload) => {
      for (const t of tokens) {
        try {
          event.sender.send(IPC.PREFLIGHT_PROGRESS, { ...payload, token: t });
        } catch {
          // Renderer was destroyed before the scan finished.
        }
      }
    };

    const promise = policyReady
      .then(() =>
        startDetection.runChecksOnce(onProgress, {
          token,
          isCurrent: () => _pageGeneration === generation,
        })
      )
      .finally(() => {
        if (_preflightInFlight?.promise === promise) {
          _preflightInFlight = null;
        }
      });
    _preflightInFlight = { promise, generation, tokens };

    const result = await promise;
    if (_pageGeneration === generation) {
      startPreProceedMonitor(getWindow());
    }
    return result;
  });

  // Identity verification: store candidate photo for sessionStorage injection.
  registerHandler(IPC.STORE_CANDIDATE_PHOTO, SCOPE.LOCAL, (_event, dataUrl) => {
    logger.info("[ipc] store-candidate-photo received");
    return storeCandidatePhoto(dataUrl);
  });

  // Sent by the local role-selection page; this is what navigates to the interview site.
  registerSend(IPC.PROCEED_TO_INTERVIEW, SCOPE.LOCAL, (_event, payload) => {
    const roleSelection = sanitizeRoleSelection(payload);
    logger.info("[ipc] proceed-to-interview received", {
      is_custom_role: roleSelection.is_custom_role,
    });

    // Freshness isn't required here: the later steps legitimately age the pass.
    const gate = startDetection.verifyProceedAllowed({ requireFresh: false });
    if (!gate.ok) {
      logger.warn(`[ipc] proceed-to-interview REFUSED — ${gate.reason}`);
      loadSecurityCheck();
      return;
    }

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
    const { valid, safe } = validateProcessName(processName);
    if (!valid) {
      logger.warn("[ipc] kill-blocked-app rejected — invalid processName:", processName);
      return {
        success: false,
        outcome: "not-blocked",
        error: "Invalid process name",
        processName: String(processName).slice(0, 40),
      };
    }
    logger.info("[ipc] kill-blocked-app:", safe);
    const result = await killSingleProcess(safe);
    // So the next scan doesn't still show the app from the 3s process cache.
    invalidateProcessCache();
    return result;
  });

  // A standard user can't complete an elevation prompt, so it isn't offered to them.
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

    // The consent dialog would cover the proctored screen mid-session.
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

  registerHandler(IPC.KILL_THREAT_PROCESS, SCOPE.LOCAL, async (_event, pid, processName) => {
    const { valid, safe } = validateProcessName(processName);
    const reply = (outcome, error) => ({
      processName: valid ? safe : String(processName).slice(0, 40),
      pid,
      success: false,
      outcome,
      error,
    });
    if (startDetection.isSessionActive?.()) {
      logger.warn("[ipc] kill-threat-process REFUSED — interview session is active");
      return reply("access-denied", "Not available during an interview");
    }
    if (!valid) {
      return reply("not-blocked", "Invalid process name");
    }
    logger.info(`[ipc] kill-threat-process: ${safe} (pid ${pid})`);
    const result = await killThreatProcess(pid, safe, startDetection.getThreatProcesses());
    invalidateProcessCache();
    return result;
  });

  registerHandler(IPC.KILL_ALL_BLOCKED_APPS, SCOPE.LOCAL, async (_event, processNames) => {
    if (!Array.isArray(processNames)) {
      logger.warn("[ipc] kill-all-blocked-apps rejected — not an array");
      return [];
    }
    // One result per requested name, at its original index.
    const validated = processNames.map((n) => ({ ...validateProcessName(n), original: n }));
    const validNames = validated.filter((r) => r.valid).map((r) => r.safe);

    logger.info("[ipc] kill-all-blocked-apps:", validNames);
    const killed = await killAllProcesses(validNames);
    invalidateProcessCache();

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

  // ── Auto-updater
  registerSend(IPC.INSTALL_UPDATE, SCOPE.LOCAL, () => {
    logger.info("[ipc] install-update received");
    // Refused internally during an interview.
    updater.installUpdate();
  });

  // Lets a page recover updater events it missed before its listeners attached.
  registerHandler(IPC.GET_UPDATE_STATE, SCOPE.LOCAL, () => updater.getState());

  registerHandler(IPC.GET_APP_VERSION, SCOPE.LOCAL, () => app.getVersion());

  registerHandler(IPC.GET_AUDIT_LOG, SCOPE.LOCAL, () => {
    return startDetection.getAuditLog ? startDetection.getAuditLog() : [];
  });

  registerHandler(IPC.GET_SUPPORT_INFO, SCOPE.LOCAL, () => ({ available: supportUrl() !== null }));

  registerSend(IPC.OPEN_SUPPORT, SCOPE.LOCAL, () => {
    const url = supportUrl();
    if (!url) {
      return;
    }
    shell.openExternal(url).catch((err) => logger.warn("[ipc] open-support failed:", err.message));
  });

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

    killAgent();

    // Recording keeps going until PROCTORING_STOP, so the video includes the result screen.
    endInterview(safeReason);

    updater.onInterviewEnded();
  });

  screenRecorder.registerRecorderIpc();

  registerHandler(IPC.PROCTORING_START, SCOPE.INTERVIEW, async (_event, meta = {}) => {
    const safeSessionId = typeof meta?.sessionId === "string" ? meta.sessionId.slice(0, 100) : null;
    const safeInterviewId =
      typeof meta?.interviewId === "string" ? meta.interviewId.slice(0, 100) : null;
    logger.info("[ipc] proctoring-start", {
      sessionId: safeSessionId,
      interviewId: safeInterviewId,
    });
    // Only an interview started through the security check may run. Anything
    // else (a reload after the last one ended) goes back to the dashboard.
    if (!getIsInterviewActive()) {
      logger.warn("[ipc] proctoring-start refused — interview is not locked down");
      _leaveInterviewFlowToDashboard({ alreadyTornDown: true });
      return { ok: false, error: "Interview is not locked down" };
    }
    return await screenRecorder.start({ sessionId: safeSessionId, interviewId: safeInterviewId });
  });

  registerSend(IPC.PROCTORING_STOP, SCOPE.INTERVIEW, () => {
    logger.info("[ipc] proctoring-stop");
    screenRecorder.stop();
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
