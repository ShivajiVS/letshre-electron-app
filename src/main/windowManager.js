/** The main window: creation, hardening, interview lockdown and page navigation. */

"use strict";

const path = require("path");
const { app, BrowserWindow, session, dialog, nativeImage } = require("electron");
const logger = require("./logger");
const appState = require("./appState");
const localeManager = require("./localeManager");
const { createLockdownGuard, releaseLock } = require("./lockdownGuard");
const { INTERVIEW_BASE_URL, DEVTOOLS_ENABLED } = require("../shared/constants");

/**
 * Text for the native "Exit Interview?" dialog. It is drawn by the main process,
 * so it can't use the locale bundles. Machine-translated: needs a native review
 * before these locales ship.
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

/** @type {ReturnType<typeof createLockdownGuard> | null} */
let lockdownGuard = null;

/** @type {(event: string, severity: string) => void} */
let reportViolation = () => {};

/** @type {string | null} base64 photo from identity verification */
let _candidatePhotoBase64 = null;

const LOAD_RETRY_DELAYS_MS = [3000, 5000, 10000, 20000, 30000];

let interviewUrl = null;
let pendingInjection = null;
let loadRetryTimer = null;
let loadRetryAttempt = 0;

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

  reportViolation = onViolation;

  win.on("closed", () => {
    lockdownGuard?.stop();
    lockdownGuard = null;
    win = null;
  });

  if (app.isPackaged) {
    win.webContents.on("devtools-opened", () => {
      win.webContents.closeDevTools();
      logger.warn("[window] DevTools open attempt blocked (packaged build)");
    });
  } else if (DEVTOOLS_ENABLED) {
    win.webContents.openDevTools({ mode: "right" });
  }

  _applyInputLockdown();
  _applyNavigationGuardrails();
  _applyWindowProtections(onViolation);
  _applyInterviewLoadHandling();
  _applyCSPHeaders();

  return win;
}

function _releaseLockdown() {
  isInterviewActive = false;
  lockdownGuard?.stop();
  lockdownGuard = null;
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
  interviewUrl = null;
  pendingInjection = null;
  releaseLock(win);
}

/**
 * Lifts the lockdown once the interview site reports the session is over.
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

  _releaseLockdown();
  logger.info(`[window] interview ended (reason: ${reason}) — window restrictions lifted`);
}

/**
 * Locks the window and loads the interview. Tokens, photo, role and locale are
 * injected into the site's sessionStorage on dom-ready, before its scripts run.
 *
 * @param {string} url
 * @param {{ accessToken: string|null, refreshToken: string|null } | null} tokens
 * @param {{ is_custom_role: boolean, selected_role?: string[], manual_skills?: string[] } | null} roleSelection
 */
function lockdownForInterview(url, tokens = null, roleSelection = null) {
  if (!win) {
    return;
  }
  isInterviewActive = true;

  lockdownGuard?.stop();
  lockdownGuard = createLockdownGuard(win, { onViolation: reportViolation, log: logger });
  lockdownGuard.start();

  // One tab is reused across interviews, so a finished session left in
  // sessionStorage would come back as a stale scorecard.
  const statements = [
    "sessionStorage.removeItem('interview_session');",
    `sessionStorage.setItem('locale', ${JSON.stringify(localeManager.getPreferred())});`,
  ];
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
    statements.push(
      `sessionStorage.setItem('role_selection', ${JSON.stringify(JSON.stringify(roleSelection))});`
    );
  }

  interviewUrl = url;
  pendingInjection = statements.join("\n");
  loadRetryAttempt = 0;
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;

  logger.info("[window] lockdown activated — navigating to interview");
  win.loadURL(url).catch(() => {});
}

function _isInterviewPage(url) {
  return Boolean(INTERVIEW_BASE_URL) && String(url || "").startsWith(INTERVIEW_BASE_URL);
}

/** Reloads the interview after a failed load. The lockdown stays on throughout. */
function retryInterview() {
  if (!win || win.isDestroyed() || !isInterviewActive || !interviewUrl) {
    return;
  }
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
  logger.info("[window] retrying interview load");
  win.loadURL(interviewUrl).catch(() => {});
}

/**
 * Electron leaves a blank white page when a load fails, so a failed interview
 * load shows a local "can't reach the interview" page and keeps retrying.
 */
function _applyInterviewLoadHandling() {
  const wc = win.webContents;
  // Error pages fire dom-ready under the interview URL but never did-navigate,
  // so this is what keeps the injection off them.
  let interviewPageCommitted = false;

  const onLoadFailed = (reason) => {
    interviewPageCommitted = false;
    const delay = LOAD_RETRY_DELAYS_MS[Math.min(loadRetryAttempt, LOAD_RETRY_DELAYS_MS.length - 1)];
    loadRetryAttempt += 1;
    logger.warn(
      `[window] interview failed to load (${reason}) — retry ${loadRetryAttempt} in ${delay / 1000}s`
    );
    wc.loadFile(path.join(__dirname, "../../assets/interview-unavailable.html")).catch(() => {});
    clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(retryInterview, delay);
  };

  wc.on("did-navigate", (_event, url, httpResponseCode) => {
    const isInterview = isInterviewActive && _isInterviewPage(url);
    interviewPageCommitted = isInterview && httpResponseCode < 500;
    if (isInterview && httpResponseCode >= 500) {
      onLoadFailed(`HTTP ${httpResponseCode}`);
    }
  });

  wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: the load was replaced by another navigation, not a failure.
    if (!isInterviewActive || !isMainFrame || code === -3 || !_isInterviewPage(url)) {
      return;
    }
    onLoadFailed(`${code} ${description}`);
  });

  wc.on("dom-ready", () => {
    if (!isInterviewActive || !pendingInjection || !interviewPageCommitted) {
      return;
    }
    const script = pendingInjection;
    wc.executeJavaScript(script)
      .then(() => {
        if (pendingInjection === script) {
          pendingInjection = null;
        }
      })
      .catch((err) => logger.warn("[window] sessionStorage injection failed:", err.message));
  });

  wc.on("did-finish-load", () => {
    if (interviewPageCommitted) {
      loadRetryAttempt = 0;
    }
  });
}

/** @param {string} dataUrl base64 data URL from identity verification */
function storeCandidatePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    logger.warn("[window] storeCandidatePhoto: invalid data URL, ignoring");
    return;
  }
  _candidatePhotoBase64 = dataUrl;
  logger.info("[window] candidate photo stored for interview injection");
}

/** Called on logout so one account's photo never reaches another account's interview. */
function clearCandidatePhoto() {
  _candidatePhotoBase64 = null;
}

/** Wipes the interview site's stored data on logout so it can't carry into the next account. */
function clearInterviewSessionData() {
  return session.defaultSession
    .clearStorageData({
      origin: INTERVIEW_BASE_URL,
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    })
    .then(() => logger.info("[window] interview site storage cleared"))
    .catch((err) => logger.warn("[window] clearInterviewSessionData failed:", err.message));
}

/** Blocks DevTools shortcuts, Alt+F4 and F11 during the interview, and locks system keys. */
function _applyInputLockdown() {
  win.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.meta && input.alt && input.key === "I");

    // Before the interview the candidate may need to leave the app to close other windows.
    const isAltF4 = input.alt && input.key === "F4" && isInterviewActive;
    const isFullscreenToggle = input.key === "F11" && isInterviewActive;

    if ((isDevTools && !DEVTOOLS_ENABLED) || isAltF4 || isFullscreenToggle) {
      event.preventDefault();
    }
  });

  // Keyboard lock only holds while the page itself is fullscreen, so it is
  // (re)applied each time the interview enters fullscreen.
  win.webContents.on("enter-html-full-screen", () => {
    if (!isInterviewActive || !_isInterviewPage(win.webContents.getURL())) {
      return;
    }
    win.webContents
      .executeJavaScript(
        "navigator.keyboard ? navigator.keyboard.lock() : Promise.reject(new Error('Keyboard API unavailable'))",
        true
      )
      .then(() => logger.info("[window] keyboard lock on"))
      .catch((err) => logger.warn("[window] keyboard lock failed:", err.message));
  });
}

/** Only the interview site and local pages may load; window.open is always refused. */
function _applyNavigationGuardrails() {
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(INTERVIEW_BASE_URL) && !url.startsWith("file://")) {
      logger.warn("[window] blocked navigation to:", url);
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Confirms before closing during an interview. Minimize is held by lockdownGuard. */
function _applyWindowProtections(onViolation) {
  win.on("close", (e) => {
    if (!isInterviewActive) {
      appState.setQuitting();
      return;
    }

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
      // Released first so a quit-time prompt is not hidden behind the locked window.
      _releaseLockdown();
      app.quit();
    } else {
      logger.warn("[window] user dismissed close dialog during interview");
      onViolation("Attempt to close interview window", "high");
    }
  });
}

function _applyCSPHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Local pages only: the interview site sends its own CSP, and overriding it
    // breaks its images and API calls.
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

function getWindow() {
  return win;
}

function getIsInterviewActive() {
  return isInterviewActive;
}

/** Lets the candidate minimize before the interview to close other apps. No-op once it starts. */
function minimizeWindow() {
  if (win && !isInterviewActive) {
    win.minimize();
  }
}

function loadSecurityCheck() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/preflight.html"));
  }
}

function loadLanguageSelectionPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/language-selection.html"));
  }
}

function loadPermissionsPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/permissions.html"));
  }
}

function loadIdentityVerificationPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/identity-verification.html"));
  }
}

function loadDashboard() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/dashboard.html"));
  }
}

function loadRoleSelectionPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/role-selection.html"));
  }
}

function loadHowItWorksPage() {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets/how-it-works.html"));
  }
}

module.exports = {
  createWindow,
  lockdownForInterview,
  retryInterview,
  storeCandidatePhoto,
  clearCandidatePhoto,
  clearInterviewSessionData,
  endInterview,
  loadDashboard,
  loadSecurityCheck,
  loadLanguageSelectionPage,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
};
