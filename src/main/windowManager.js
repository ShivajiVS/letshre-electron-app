/**
 * Owns the full BrowserWindow lifecycle:
 *   - Window creation and configuration
 *   - Security hardening (input lockdown, navigation guardrails, CSP)
 *   - Interview lockdown mode (kiosk, always-on-top)
 *   - Window event protections (minimize, close)
 */

"use strict";

const path = require("path");
const { app, BrowserWindow, session, dialog, nativeImage } = require("electron");
const logger = require("./logger");
const appState = require("./appState");
const localeManager = require("./localeManager");
const { INTERVIEW_BASE_URL, IPC } = require("../shared/constants");

/**
 * Text for the native "Exit Interview?" close-confirmation dialog, keyed by
 * locale code. This dialog is drawn by dialog.showMessageBoxSync() before any
 * renderer or i18n bundle is involved, so it can't consume assets/locales/*.json
 * the way page controllers do — it needs its own small, self-contained map.
 * Machine-translated, not yet reviewed by a native speaker (unlike
 * assets/locales/en.json's `attestation` key, which is certified) — flag for
 * human review before any of these locales ship to production.
 */
const EXIT_MODAL_STRINGS = {
  en: {
    title: "Exit Interview?",
    message: "Are you sure you want to exit?",
    detail:
      "Closing the app during an active interview session will be recorded and may be flagged to the interviewer.",
    exit: "Exit Interview",
    cancel: "Cancel",
  },
  ar: {
    title: "إنهاء المقابلة؟",
    message: "هل أنت متأكد أنك تريد الخروج؟",
    detail: "سيتم تسجيل إغلاق التطبيق أثناء جلسة مقابلة نشطة وقد يتم إبلاغ المحاور بذلك.",
    exit: "إنهاء المقابلة",
    cancel: "إلغاء",
  },
  bn: {
    title: "সাক্ষাৎকার থেকে বের হবেন?",
    message: "আপনি কি নিশ্চিত যে আপনি বের হতে চান?",
    detail:
      "সক্রিয় সাক্ষাৎকার চলাকালীন অ্যাপ বন্ধ করা রেকর্ড করা হবে এবং সাক্ষাৎকারগ্রহীতাকে জানানো হতে পারে।",
    exit: "সাক্ষাৎকার থেকে বের হন",
    cancel: "বাতিল",
  },
  de: {
    title: "Interview verlassen?",
    message: "Möchten Sie das Interview wirklich verlassen?",
    detail:
      "Das Schließen der App während einer aktiven Interviewsitzung wird aufgezeichnet und dem Interviewer möglicherweise gemeldet.",
    exit: "Interview verlassen",
    cancel: "Abbrechen",
  },
  es: {
    title: "¿Salir de la entrevista?",
    message: "¿Estás seguro de que deseas salir?",
    detail:
      "Cerrar la aplicación durante una sesión de entrevista activa quedará registrado y podría notificarse al entrevistador.",
    exit: "Salir de la entrevista",
    cancel: "Cancelar",
  },
  fr: {
    title: "Quitter l’entretien ?",
    message: "Êtes-vous sûr de vouloir quitter ?",
    detail:
      "La fermeture de l’application pendant un entretien actif sera enregistrée et pourra être signalée à l’intervieweur.",
    exit: "Quitter l’entretien",
    cancel: "Annuler",
  },
  hi: {
    title: "साक्षात्कार से बाहर निकलें?",
    message: "क्या आप वाकई बाहर निकलना चाहते हैं?",
    detail:
      "सक्रिय साक्षात्कार सत्र के दौरान ऐप बंद करना रिकॉर्ड किया जाएगा और साक्षात्कारकर्ता को सूचित किया जा सकता है।",
    exit: "साक्षात्कार से बाहर निकलें",
    cancel: "रद्द करें",
  },
  id: {
    title: "Keluar dari Wawancara?",
    message: "Apakah Anda yakin ingin keluar?",
    detail:
      "Menutup aplikasi selama sesi wawancara aktif akan dicatat dan dapat dilaporkan kepada pewawancara.",
    exit: "Keluar dari Wawancara",
    cancel: "Batal",
  },
  it: {
    title: "Uscire dal colloquio?",
    message: "Sei sicuro di voler uscire?",
    detail:
      "La chiusura dell’app durante un colloquio attivo verrà registrata e potrebbe essere segnalata all’intervistatore.",
    exit: "Esci dal colloquio",
    cancel: "Annulla",
  },
  ja: {
    title: "面接を終了しますか？",
    message: "本当に終了してもよろしいですか？",
    detail: "面接セッション中にアプリを閉じると記録され、面接担当者に通知される場合があります。",
    exit: "面接を終了",
    cancel: "キャンセル",
  },
  kn: {
    title: "ಸಂದರ್ಶನದಿಂದ ನಿರ್ಗಮಿಸುವುದೇ?",
    message: "ನೀವು ಖಚಿತವಾಗಿ ನಿರ್ಗಮಿಸಲು ಬಯಸುವಿರಾ?",
    detail:
      "ಸಕ್ರಿಯ ಸಂದರ್ಶನ ಅವಧಿಯಲ್ಲಿ ಅಪ್ಲಿಕೇಶನ್ ಅನ್ನು ಮುಚ್ಚುವುದನ್ನು ದಾಖಲಿಸಲಾಗುತ್ತದೆ ಮತ್ತು ಸಂದರ್ಶಕರಿಗೆ ವರದಿ ಮಾಡಬಹುದು.",
    exit: "ಸಂದರ್ಶನದಿಂದ ನಿರ್ಗಮಿಸಿ",
    cancel: "ರದ್ದುಮಾಡಿ",
  },
  ko: {
    title: "면접을 종료하시겠습니까?",
    message: "정말로 종료하시겠습니까?",
    detail: "활성 면접 세션 중 앱을 닫으면 기록되며 면접관에게 보고될 수 있습니다.",
    exit: "면접 종료",
    cancel: "취소",
  },
  ml: {
    title: "അഭിമുഖത്തിൽ നിന്ന് പുറത്തുകടക്കണോ?",
    message: "നിങ്ങൾക്ക് ഉറപ്പാണോ പുറത്തുകടക്കണമെന്ന്?",
    detail:
      "സജീവമായ അഭിമുഖ സെഷനിൽ ആപ്പ് അടയ്ക്കുന്നത് രേഖപ്പെടുത്തുകയും അഭിമുഖം നടത്തുന്നയാളെ അറിയിക്കുകയും ചെയ്തേക്കാം.",
    exit: "അഭിമുഖത്തിൽ നിന്ന് പുറത്തുകടക്കുക",
    cancel: "റദ്ദാക്കുക",
  },
  nl: {
    title: "Interview verlaten?",
    message: "Weet u zeker dat u wilt afsluiten?",
    detail:
      "Het sluiten van de app tijdens een actieve interviewsessie wordt geregistreerd en kan aan de interviewer worden gemeld.",
    exit: "Interview verlaten",
    cancel: "Annuleren",
  },
  pt: {
    title: "Sair da entrevista?",
    message: "Tem certeza de que deseja sair?",
    detail:
      "Fechar o aplicativo durante uma sessão de entrevista ativa será registrado e pode ser sinalizado ao entrevistador.",
    exit: "Sair da entrevista",
    cancel: "Cancelar",
  },
  ru: {
    title: "Выйти из интервью?",
    message: "Вы уверены, что хотите выйти?",
    detail:
      "Закрытие приложения во время активной сессии интервью будет зафиксировано и может быть сообщено интервьюеру.",
    exit: "Выйти из интервью",
    cancel: "Отмена",
  },
  ta: {
    title: "நேர்காணலிலிருந்து வெளியேறவா?",
    message: "நீங்கள் நிச்சயமாக வெளியேற விரும்புகிறீர்களா?",
    detail:
      "செயலில் உள்ள நேர்காணல் அமர்வின் போது பயன்பாட்டை மூடுவது பதிவு செய்யப்பட்டு நேர்காணல் செய்பவருக்குத் தெரிவிக்கப்படலாம்.",
    exit: "நேர்காணலிலிருந்து வெளியேறு",
    cancel: "ரத்துசெய்",
  },
  te: {
    title: "ఇంటర్వ్యూ నుండి నిష్క్రమించాలా?",
    message: "మీరు ఖచ్చితంగా నిష్క్రమించాలనుకుంటున్నారా?",
    detail:
      "యాక్టివ్ ఇంటర్వ్యూ సెషన్ సమయంలో యాప్‌ను మూసివేయడం రికార్డ్ చేయబడుతుంది మరియు ఇంటర్వ్యూయర్‌కు ఫ్లాగ్ చేయబడవచ్చు.",
    exit: "ఇంటర్వ్యూ నుండి నిష్క్రమించండి",
    cancel: "రద్దు చేయండి",
  },
  ur: {
    title: "انٹرویو سے باہر نکلیں؟",
    message: "کیا آپ واقعی باہر نکلنا چاہتے ہیں؟",
    detail:
      "فعال انٹرویو سیشن کے دوران ایپ بند کرنا ریکارڈ کیا جائے گا اور انٹرویو لینے والے کو رپورٹ کیا جا سکتا ہے۔",
    exit: "انٹرویو سے باہر نکلیں",
    cancel: "منسوخ کریں",
  },
};

function _exitModalStrings() {
  return EXIT_MODAL_STRINGS[localeManager.getPreferred()] || EXIT_MODAL_STRINGS.en;
}

/** @type {BrowserWindow | null} */
let win = null;

/** @type {boolean} */
let isInterviewActive = false;

/** @type {string | null} — base64 JPEG captured during identity verification, injected into the interview SPA sessionStorage on dom-ready */
let _candidatePhotoBase64 = null;

/**
 * Creates and configures the main application window.
 * @param {(event: string, severity: string) => void} onViolation
 * @param {'login'|'dashboard'} [startPage='login'] - Which page to open on launch.
 * @returns {BrowserWindow}
 */
function createWindow(onViolation, startPage = "login") {
  if (win && !win.isDestroyed()) {
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    title: "",
    icon: nativeImage.createEmpty(),
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../../preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Explicit Electron security checklist hardening
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });

  win.maximize();

  const pageFiles = { login: "login.html", dashboard: "dashboard.html" };
  const pageFile = pageFiles[startPage] || pageFiles.login;
  win.loadFile(path.join(__dirname, "../../assets", pageFile));

  win.setMenuBarVisibility(false);

  win.on("closed", () => {
    win = null;
  });

  //  Block DevTools in production builds
  if (app.isPackaged) {
    win.webContents.on("devtools-opened", () => {
      win.webContents.closeDevTools();
      logger.warn("[window] DevTools open attempt blocked (packaged build)");
    });
  }

  _applyInputLockdown();
  _applyNavigationGuardrails();
  _applyWindowProtections(onViolation);
  _applyCSPHeaders();

  return win;
}

// ─── Interview End
/**
 * Called when the interview session ends (signal received from interview.letshyre.com).
 * Clears the lockdown flag and restores normal window behaviour so the candidate
 * can close or minimise the app once the interview is fully complete.
 *
 * @param {string} reason - e.g. "completed", "auto-submitted", "terminated", "expired"
 */
function endInterview(reason) {
  if (!win) {
    return;
  }
  if (!isInterviewActive) {
    logger.info("[window] endInterview called but interview was already inactive — skipping");
    return;
  }

  isInterviewActive = false;

  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);

  logger.info(`[window] interview ended (reason: ${reason}) — window restrictions lifted`);
}

// ─── Self-Enforced Violation

/**
 * Failsafe: fires when a hard-block violation was pushed to the website but
 * the session is still active after the grace window (renderer dropped the
 * event or failed to terminate). Lifts lockdown so the candidate can read
 * the screen and retries the violation push via IPC, guaranteeing a
 * hard-block has a consequence even if the website never handles it.
 * @param {string} reason
 */
function enforceViolation(reason) {
  if (!win || win.isDestroyed()) {
    return;
  }

  isInterviewActive = false;
  win.setAlwaysOnTop(false);
  win.setKiosk(false);
  win.setFullScreen(false);
  win.setMinimizable(true);

  // Retry pushing the violation via IPC — by T+8s the session will have loaded
  // and the interview page's buffered-violation flush will show the modal.
  try {
    win.webContents.send(IPC.PUSH_VIOLATION, {
      event: String(reason).slice(0, 200),
      severity: "high",
      count: 1,
      isHardBlock: true,
      source: "electron",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn("[window] violation IPC retry failed:", err.message);
  }

  logger.warn(`[window] self-enforced violation — IPC retry sent: ${reason}`);
}

// ─── Interview Lockdown

/**
 * Activates full interview lockdown mode and injects auth tokens + candidate
 * photo into the SPA's sessionStorage before React boots.
 *
 * Injection uses webContents.executeJavaScript() on the dom-ready event, which
 * fires after the HTML is parsed but before module scripts execute — no race.
 *
 * @param {string} interviewUrl
 * @param {{ accessToken: string|null, refreshToken: string|null } | null} tokens
 * @param {{ is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] } | null} roleSelection
 */
function lockdownForInterview(interviewUrl, tokens = null, roleSelection = null) {
  if (!win) {
    return;
  }
  isInterviewActive = true;

  win.setAlwaysOnTop(true, "screen-saver");
  win.setKiosk(true);
  win.setFullScreen(true);
  win.setMinimizable(false);

  win.webContents.once("dom-ready", () => {
    // A new interview is starting — wipe any finished session sessionStorage
    // still holds. Electron reuses one long-lived tab, so a prior completed
    // session would otherwise survive the scorecard → dashboard → new-interview
    // trip and get restored as a stale scorecard. Runs before the SPA's first
    // render, same as the candidate_photo injection below.
    const statements = ["sessionStorage.removeItem('interview_session');"];
    // Candidate's chosen UI language, so the interview SPA can render in it too
    // — previously only sent separately to authManager for STT model selection,
    // never to the web app itself (see README "Web app integration").
    statements.push(
      `sessionStorage.setItem('locale', ${JSON.stringify(localeManager.getPreferred())});`
    );
    if (tokens?.accessToken) {
      statements.push(`sessionStorage.setItem('ac', ${JSON.stringify(tokens.accessToken)});`);
    }
    if (tokens?.refreshToken) {
      statements.push(`sessionStorage.setItem('rc', ${JSON.stringify(tokens.refreshToken)});`);
    }
    if (_candidatePhotoBase64) {
      statements.push(
        `sessionStorage.setItem('candidate_photo', ${JSON.stringify(_candidatePhotoBase64)});`
      );
    }
    if (roleSelection) {
      // JSON-encode twice: once for the stored value, once to embed it as a
      // string literal inside the injected executeJavaScript() statement.
      statements.push(
        `sessionStorage.setItem('role_selection', ${JSON.stringify(JSON.stringify(roleSelection))});`
      );
    }

    win.webContents
      .executeJavaScript(statements.join("\n"))
      .catch((err) => logger.warn("[window] sessionStorage injection failed:", err.message));
  });

  win.loadURL(interviewUrl);
  logger.info("[window] lockdown activated — navigating to interview");
}

/**
 * Stores the base64 photo captured during identity verification so it can be
 * injected into the interview SPA sessionStorage on the next dom-ready event.
 * @param {string} dataUrl — base64 data URL ("data:image/jpeg;base64,…")
 */
function storeCandidatePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    logger.warn("[window] storeCandidatePhoto: invalid data URL, ignoring");
    return;
  }
  _candidatePhotoBase64 = dataUrl;
  logger.info("[window] candidate photo stored for interview injection");
}

/**
 * Clears the in-memory candidate photo. Called on logout so one account's face
 * capture can never linger into another account's session.
 */
function clearCandidatePhoto() {
  _candidatePhotoBase64 = null;
}

/**
 * Wipes the interview site's persisted storage (cookies, localStorage,
 * IndexedDB, service worker + cache) for INTERVIEW_BASE_URL on logout, so a
 * previous candidate's tokens/data don't carry into the next account.
 * sessionStorage isn't touched — the interview page isn't loaded at logout,
 * and the next interview overwrites it anyway.
 * @returns {Promise<void>}
 */
function clearInterviewSessionData() {
  return session.defaultSession
    .clearStorageData({
      origin: INTERVIEW_BASE_URL,
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    })
    .then(() => logger.info("[window] interview site storage cleared"))
    .catch((err) => logger.warn("[window] clearInterviewSessionData failed:", err.message));
}

// ─── Internal Hardening

/** Blocks DevTools, Ctrl+Shift+I, Meta+Alt+I, and Alt+F4 key combos. */
function _applyInputLockdown() {
  win.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.meta && input.alt && input.key === "I");

    // Alt+F4 is only blocked during an active interview session.
    // During requirements/preflight the user may need to Alt+F4 out of this
    // app temporarily to manually close other windows before rescanning.
    const isAltF4 = input.alt && input.key === "F4" && isInterviewActive;

    if (isDevTools || isAltF4) {
      event.preventDefault();
    }
  });
}

/**
 * Prevents navigation to any URL outside the interview domain or local files.
 * Also blocks all window.open() calls.
 */
function _applyNavigationGuardrails() {
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(INTERVIEW_BASE_URL) && !url.startsWith("file://")) {
      logger.warn("[window] blocked navigation to:", url);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Prevents minimize and close during an active interview session. */
function _applyWindowProtections(onViolation) {
  win.on("minimize", (e) => {
    if (!isInterviewActive) {
      return;
    }
    e.preventDefault();
    win.restore();
    win.focus();
    onViolation("Window minimize attempt", "high");
  });

  win.on("close", (e) => {
    if (!isInterviewActive) {
      appState.setQuitting();
      return;
    } // preflight — allow close freely

    // Interview is active: show a native confirmation dialog instead of hard-blocking.
    // This allows the user to close the app if they genuinely need to,
    // while still logging a violation if they cancel.
    e.preventDefault();

    const modalStrings = _exitModalStrings();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: [modalStrings.exit, modalStrings.cancel],
      defaultId: 1, // default highlight: Cancel (safer)
      cancelId: 1,
      title: modalStrings.title,
      message: modalStrings.message,
      detail: modalStrings.detail,
      noLink: true,
    });

    if (choice === 0) {
      logger.warn("[window] user confirmed interview exit via close dialog");
      isInterviewActive = false;
      app.quit();
    } else {
      logger.warn("[window] user dismissed close dialog during interview");
      onViolation("Attempt to close interview window", "high");
    }
  });
}

/**
 * Sets a Content-Security-Policy response header on all requests
 * served through the default session.
 */
function _applyCSPHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only enforce a strict CSP on local pages (preflight.html, etc.).
    // interview.letshyre.com manages its own server-side CSP —
    // overriding it here blocks images, API calls, and other resources
    // that work fine in a regular browser.
    if (!details.url.startsWith("file://")) {
      return callback({ responseHeaders: details.responseHeaders });
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "font-src 'self' https://fonts.gstatic.com data:; " + // 'self' also serves assets/fonts/*.woff2 (i18n Noto subsets)
            "img-src 'self' data: blob: https://api.letshyre.com; " +
            "media-src 'self' blob:; " +
            "connect-src 'self' http://127.0.0.1:9999;",
        ],
      },
    });
  });
}

// ─── Accessors

function getWindow() {
  return win;
}

function getIsInterviewActive() {
  return isInterviewActive;
}

/**
 * Minimizes the window — safe to call during requirements/preflight phase.
 * During active interview the window lock prevents minimize via the close handler,
 * so this function is effectively a no-op if somehow invoked then.
 */
function minimizeWindow() {
  if (win && !isInterviewActive) {
    win.minimize();
  }
}

/**
 * Navigates to the security-check (preflight) screen. Called after the user
 * picks "Take Interview" on the dashboard — the interview session tokens are
 * set first by the IPC handler. The preflight → permissions → lockdown →
 * interview flow is unchanged from here.
 */
function loadSecurityCheck() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  }
}

/**
 * Navigates to the permissions page. Called when the user clicks Proceed on
 * the preflight screen — all security checks have passed but the window is
 * NOT yet in kiosk/lockdown mode (the OS needs to show native permission
 * dialogs). Lockdown happens only after the user clicks Start Interview.
 */
function loadPermissionsPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/permissions.html"));
  }
}

/**
 * Navigates to the identity verification page. Called after all permissions
 * are granted — camera/mic/screen already approved by the OS.
 */
function loadIdentityVerificationPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/identity-verification.html"));
  }
}

/**
 * Navigates back to the dashboard. Used by the back button on the security
 * check page — does not clear the session, just shows the dashboard again.
 */
function loadDashboard() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/dashboard.html"));
  }
}

/**
 * Navigates to the role selection page. Called after identity verification
 * passes — candidate confirms or enters their role before interview lockdown.
 */
function loadRoleSelectionPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/role-selection.html"));
  }
}

/**
 * Navigates to the how-it-works page. Accessible from login and dashboard —
 * no auth required, purely informational.
 */
function loadHowItWorksPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/how-it-works.html"));
  }
}

module.exports = {
  createWindow,
  lockdownForInterview,
  storeCandidatePhoto,
  clearCandidatePhoto,
  clearInterviewSessionData,
  endInterview,
  enforceViolation,
  loadDashboard,
  loadSecurityCheck,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
};
