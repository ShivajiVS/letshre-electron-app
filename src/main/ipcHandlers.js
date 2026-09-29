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
const { IPC, SUPPORT_URL, SUPPORT_EMAIL, DEVTOOLS_ENABLED } = require("../shared/constants");
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
  loadPracticeCheck,
  loadLanguageSelectionPage,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
  isShowingUnavailablePage,
  confirmLeaveStalledStart,
} = require("./windowManager");
const { createStartWatchdog } = require("./startWatchdog");
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
const flowGuard = require("./flowGuard");
const supportReference = require("./supportReference");
const { languageStepShown } = require("../shared/flowSteps");
const screenRecorder = require("./screenRecorder");
const blocklistPolicy = require("./blocklistPolicy");
const { getLists, getDisplayNames } = require("../shared/blocklist");
const { createViolationSimulator } = require("./devViolations");
const { startPreProceedMonitor, stopPreProceedMonitor } = startDetection;

// Longest a scan waits for the company policy fetched at Start Interview.
const POLICY_WAIT_MS = 2000;
const ATTEMPTS_CHECK_MS = 4000;

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

/**
 * A threat is killed by PID and only if the agent reported that PID under this
 * exact name, so the name is kept as-is (some copilots use invisible characters).
 * @param {unknown} value
 * @returns {{ valid: boolean, safe: string }}
 */
function validateThreatName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) {
    return { valid: false, safe: "" };
  }
  return /\p{Cc}/u.test(value) ? { valid: false, safe: "" } : { valid: true, safe: value };
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

/** @returns {string|null} the support address, only when it looks like one */
function supportEmail() {
  return authValidators.validateEmail(SUPPORT_EMAIL).valid ? SUPPORT_EMAIL.trim() : null;
}

/** Starts the agent early so it is warm by the time the scan needs it. */
function prewarmAgent() {
  whenAgentReady().catch((err) => logger.warn("[ipc] agent pre-warm failed:", err.message));
}

function _languageSelectionIsMeaningful() {
  return languageStepShown(localeManager.getSupportedLocales());
}

// The pass a practice run earned must not open the steps of a real attempt.
function _endPractice() {
  if (flowGuard.isPractice()) {
    flowGuard.leavePractice();
    startDetection.resetState();
  }
}

/** Leaves the interview flow for the dashboard and stops the agent. */
function _leaveInterviewFlowToDashboard({ alreadyTornDown = false, note } = {}) {
  if (!alreadyTornDown) {
    _leaveSecurityCheck();
  }
  flowGuard.stop();
  _endPractice();
  killAgent();
  blocklistPolicy.reset();
  loadDashboard(note);
}

/**
 * Same rule as the dashboard: an explicit remaining count wins, otherwise
 * it's max minus used.
 * @returns {number|null} null when there is no profile
 */
function remainingAttempts(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  const remaining = Number(profile.interview_attempts_remaining);
  if (Number.isFinite(remaining)) {
    return remaining;
  }
  const max = Number(profile.max_interviews_allowed) || 0;
  const used = Number(profile.interview_attempts_used) || 0;
  return Math.max(0, max - used);
}

/**
 * A slow or failed profile fetch lets the candidate through; the site refuses a
 * spent attempt anyway. Kept under the dashboard button's 6s restore.
 */
async function _attemptsExhausted() {
  let timer;
  try {
    const res = await Promise.race([
      authManager.getCandidateProfile(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ATTEMPTS_CHECK_MS, null);
      }),
    ]);
    const remaining = res?.success ? remainingAttempts(res.data) : null;
    return remaining !== null && remaining <= 0;
  } catch (err) {
    logger.warn("[ipc] attempts check failed:", err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Settles once the agent has given the keyboard and touchpad back, so leaving
// never kills it halfway through.
let _lockdownRelease = Promise.resolve();
let _aborting = false;

const startWatchdog = createStartWatchdog({
  onStall: async () => {
    logger.warn("[ipc] interview has not started — asking the candidate");
    // The dialog waits on the candidate; the interview may have ended meanwhile.
    if (!(await confirmLeaveStalledStart()) || !getIsInterviewActive()) {
      return false;
    }
    return _abortInterview("start-stalled", { note: "startFailed" });
  },
});

function _releaseInterview(reason) {
  startWatchdog.disarm();
  startDetection.stop();
  // A repeated signal must not kill the agent mid-release.
  if (!getIsInterviewActive()) {
    return _lockdownRelease;
  }
  _lockdownRelease = endInterview(reason)
    .catch((err) => logger.warn("[ipc] lockdown release failed:", err.message))
    .finally(() => killAgent());
  updater.onInterviewEnded();
  return _lockdownRelease;
}

/**
 * Back to the dashboard from an interview that never got going. Refused once
 * it is running, unless the site can't be reached at all.
 * @returns {Promise<boolean>} whether the candidate left
 */
async function _abortInterview(reason, { force = false, note } = {}) {
  if (_aborting) {
    return false;
  }
  if (getIsInterviewActive() && startWatchdog.isLive() && !force) {
    logger.warn(`[ipc] abort refused — the interview is already running (${reason})`);
    return false;
  }
  _aborting = true;
  try {
    logger.info(`[ipc] leaving the interview before it started — ${reason}`);
    if (getIsInterviewActive()) {
      await _releaseInterview(reason);
    } else {
      await _lockdownRelease;
    }
    _leaveInterviewFlowToDashboard({ alreadyTornDown: true, note });
    return true;
  } finally {
    _aborting = false;
  }
}

/** @param {unknown} value @returns {string} */
function _safeReason(value) {
  const safe = typeof value === "string" ? value.replace(/[^\w:-]/g, "").slice(0, 40) : "";
  return safe || "unknown";
}

// Bumped every time the security-check page is left or reloaded. A scan from an
// older generation still finishes but can't be joined or commit its result.
let _pageGeneration = 0;
/** @type {{ promise: Promise<object>, generation: number, tokens: Set<string|null> } | null} */
let _preflightInFlight = null;
let _continuing = false;

const BOUNCE_REASONS = { stale: "stale", dirty: "dirty", scanning: "scanning" };

// Also stops the flow guard: it and the security check's own monitor never run together.
function _leaveSecurityCheck() {
  stopPreProceedMonitor();
  flowGuard.stop();
  _pageGeneration++;
}

/** Back to the security check when its pass is missing or failed. */
function _bounceToSecurityCheck() {
  _leaveSecurityCheck();
  loadSecurityCheck();
}

// One gate per forward step, so a double click can't run it twice.
const _stepsRunning = new Set();

/**
 * Gate for the steps after the security check. A step runs only when that
 * check's pass still holds (its age doesn't matter by now, the later steps
 * legitimately age it), the guard is at one of `from` (or already at `to`,
 * e.g. after a reload) and a fresh guard check is clear.
 * @param {string} step - log label
 * @param {{from: string[], to?: string}} stages
 * @param {() => void} proceed
 * @returns {Promise<{ok: true} | {ok: false, reason: string, guard?: object}>}
 */
async function _gatedStep(step, { from, to }, proceed) {
  if (_stepsRunning.has(step)) {
    return { ok: false, reason: "busy" };
  }
  _stepsRunning.add(step);
  try {
    const pass = startDetection.verifyProceedAllowed({ requireFresh: false });
    if (!pass.ok) {
      logger.warn(`[ipc] ${step} REFUSED — ${pass.reason}`);
      _bounceToSecurityCheck();
      return { ok: false, reason: "failed" };
    }
    const inOrder = () => {
      const stage = flowGuard.getStage();
      return stage !== null && (from.includes(stage) || stage === to);
    };
    if (!inOrder()) {
      logger.warn(`[ipc] ${step} REFUSED — out of order (guard stage: ${flowGuard.getStage()})`);
      return { ok: false, reason: "order" };
    }
    const guard = await flowGuard.checkNow();
    // The candidate may have gone back or left while the check ran.
    if (!inOrder()) {
      logger.warn(`[ipc] ${step} REFUSED — stage changed during the check`);
      return { ok: false, reason: "order" };
    }
    if (guard.status !== "clear") {
      logger.warn(`[ipc] ${step} REFUSED — guard ${guard.status}`);
      return { ok: false, reason: guard.status, guard };
    }
    proceed();
    return { ok: true };
  } finally {
    _stepsRunning.delete(step);
  }
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
    flowGuard.stop();
    _endPractice();
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
  registerSend(IPC.START_INTERVIEW, SCOPE.LOCAL, async () => {
    if (!authManager.getTokens()) {
      logger.warn("[ipc] start-interview rejected — not authenticated");
      return;
    }
    if (await _attemptsExhausted()) {
      logger.warn("[ipc] start-interview rejected — no attempts left");
      loadDashboard("exhausted");
      return;
    }
    // Read again: the profile fetch may have refreshed them.
    const tokens = authManager.getTokens();
    if (!tokens) {
      return;
    }
    logger.info("[ipc] start-interview — entering security check");
    setInterviewSession(tokens.accessToken, tokens.refreshToken);
    flowGuard.stop();
    _endPractice();
    supportReference.startRun();
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

  // Dashboard "Check my computer": the security check on its own. No interview
  // session and no attempts check, and the steps after it stay closed.
  registerSend(IPC.START_PRACTICE_CHECK, SCOPE.LOCAL, () => {
    const tokens = authManager.getTokens();
    if (!tokens || getIsInterviewActive()) {
      logger.warn("[ipc] start-practice-check rejected — not signed in or interview active");
      return;
    }
    logger.info("[ipc] start-practice-check");
    _leaveSecurityCheck();
    flowGuard.enterPractice();
    blocklistPolicy.loadForInterview(tokens.accessToken);
    prewarmAgent();
    loadPracticeCheck();
  });

  // Continue on the security check. Not locked down yet: the OS still has to
  // show its mic/camera/screen prompts on the permissions page.
  // Refusals go back to the page, which confirms in place instead of reloading.
  registerHandler(IPC.LOAD_PERMISSIONS_PAGE, SCOPE.LOCAL, async () => {
    logger.info("[ipc] load-permissions-page");
    if (flowGuard.isPractice()) {
      logger.warn("[ipc] load-permissions-page REFUSED — practice run");
      return { ok: false, reason: "practice" };
    }
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
      flowGuard.start(getWindow(), "permissions");
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
    if (flowGuard.isPractice()) {
      logger.warn("[ipc] back-to-permissions REFUSED — practice run");
      return;
    }
    const gate = startDetection.verifyProceedAllowed({ requireFresh: false });
    if (!gate.ok) {
      logger.warn(`[ipc] back-to-permissions REFUSED — ${gate.reason}`);
      _bounceToSecurityCheck();
      return;
    }
    if (flowGuard.isRunning()) {
      flowGuard.setStage("permissions");
    } else {
      flowGuard.start(getWindow(), "permissions");
    }
    loadPermissionsPage();
  });

  registerHandler(IPC.LOAD_IDENTITY_VERIFICATION, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-identity-verification");
    // Role selection's Back comes here too.
    const stages = { from: ["permissions", "role"], to: "identity" };
    return _gatedStep("load-identity-verification", stages, () => {
      flowGuard.setStage("identity");
      loadIdentityVerificationPage();
    });
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
    if (getIsInterviewActive()) {
      // While locked, only the "can't reach your interview" page offers this.
      if (isShowingUnavailablePage()) {
        return _abortInterview("site-unreachable", { force: true, note: "startFailed" });
      }
      logger.warn("[ipc] load-dashboard ignored — the interview is locked");
      return;
    }
    logger.info("[ipc] load-dashboard (back nav)");
    _leaveInterviewFlowToDashboard();
  });

  registerSend(IPC.VIEW_DASHBOARD, SCOPE.INTERVIEW, () => {
    if (getIsInterviewActive()) {
      logger.warn("[ipc] view-dashboard ignored — the interview has not ended");
      return;
    }
    logger.info("[ipc] view-dashboard (from scorecard)");
    return _lockdownRelease.then(() => _leaveInterviewFlowToDashboard({ alreadyTornDown: true }));
  });

  // The site couldn't start the interview: no attempts left, or a server error.
  registerSend(IPC.ABORT_INTERVIEW, SCOPE.INTERVIEW, (_event, { reason } = {}) => {
    const safeReason = _safeReason(reason);
    const note = safeReason === "attempts-exhausted" ? "exhausted" : "startFailed";
    return _abortInterview(safeReason, { note });
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
    if (!_languageSelectionIsMeaningful() || flowGuard.isPractice()) {
      logger.info("[ipc] load-language-selection — nothing to choose here, going to dashboard");
      _leaveInterviewFlowToDashboard({ alreadyTornDown: true });
      return;
    }
    logger.info("[ipc] load-language-selection (back nav)");
    // The agent stays warm: the candidate is one click from the security check.
    loadLanguageSelectionPage();
  });

  registerHandler(IPC.LOAD_ROLE_SELECTION, SCOPE.LOCAL, () => {
    logger.info("[ipc] load-role-selection");
    return _gatedStep("load-role-selection", { from: ["identity"], to: "role" }, () => {
      flowGuard.setStage("role");
      loadRoleSelectionPage();
    });
  });

  registerHandler(IPC.GET_GUARD_STATUS, SCOPE.LOCAL, () => flowGuard.getState());

  registerHandler(IPC.RECHECK_GUARD, SCOPE.LOCAL, async () => await flowGuard.checkNow());

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
      flowGuard.stop();
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
  registerHandler(IPC.PROCEED_TO_INTERVIEW, SCOPE.LOCAL, (_event, payload) => {
    const roleSelection = sanitizeRoleSelection(payload);
    logger.info("[ipc] proceed-to-interview received", {
      is_custom_role: roleSelection.is_custom_role,
    });

    return _gatedStep("proceed-to-interview", { from: ["role"] }, () => {
      // The interview's live detection takes over from the guard straight away.
      flowGuard.stop();
      stopPreProceedMonitor();

      const tokens = authManager.getTokens();
      const interviewUrl = getCurrentInterviewUrl();
      lockdownForInterview(interviewUrl, tokens, roleSelection);
      startWatchdog.arm();

      try {
        startDetection.start(getWindow());
      } catch (err) {
        logger.error("[ipc] detection start failed:", err.message);
      }
    });
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
    const { valid, safe } = validateThreatName(processName);
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

  registerHandler(IPC.GET_SUPPORT_INFO, SCOPE.LOCAL, () => ({
    available: supportUrl() !== null,
    referenceCode: supportReference.currentCode(),
  }));

  // Read-only: nothing here is secret, and the site shows it on its help screens.
  registerHandler(IPC.GET_SUPPORT_CONTACT, SCOPE.INTERVIEW, () => ({
    url: supportUrl(),
    email: supportEmail(),
    referenceCode: supportReference.currentCode(),
  }));

  registerSend(IPC.OPEN_SUPPORT, SCOPE.LOCAL, () => {
    const url = supportUrl();
    if (!url) {
      return;
    }
    shell.openExternal(url).catch((err) => logger.warn("[ipc] open-support failed:", err.message));
  });

  // Contract channel #2 (README "Web app integration"): the interview site
  // acknowledges every violation so Electron knows the page is alive.
  registerSend(IPC.ACK_VIOLATION, SCOPE.INTERVIEW, (_event, payload) => {
    const id = typeof payload?.id === "string" ? payload.id.slice(0, 64) : undefined;
    startDetection.acknowledgeViolation(id);
  });

  // Contract channel #3: the interview site signals the session is over.
  registerSend(IPC.INTERVIEW_COMPLETE, SCOPE.INTERVIEW, (_event, { reason } = {}) => {
    const safeReason = _safeReason(reason);
    logger.info(`[ipc] interview-complete received — reason: ${safeReason}`);
    // Recording keeps going until PROCTORING_STOP, so the video includes the result screen.
    _releaseInterview(safeReason);
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
    startWatchdog.markLive();
    startDetection.setSessionContext({ sessionId: safeSessionId, interviewId: safeInterviewId });
    supportReference.rememberSession(safeSessionId);
    return await screenRecorder.start({ sessionId: safeSessionId, interviewId: safeInterviewId });
  });

  const simulateViolation = createViolationSimulator({
    enabled: DEVTOOLS_ENABLED && !app.isPackaged,
    getWindow,
    isSessionActive: startDetection.isSessionActive,
    sendViolation: startDetection.sendViolation,
    logger,
  });
  registerHandler(IPC.DEV_SIMULATE_VIOLATION, SCOPE.INTERVIEW, (_event, code) =>
    simulateViolation(code)
  );

  registerSend(IPC.PROCTORING_STOP, SCOPE.INTERVIEW, () => {
    logger.info("[ipc] proctoring-stop");
    screenRecorder.stop();
  });

  logger.info("[ipc] all handlers registered");
}

module.exports = { registerIpcHandlers };
