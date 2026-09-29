/** The app window, the locked interview window, and navigation between pages. */

"use strict";

const os = require("os");
const path = require("path");
const {
  app,
  BrowserWindow,
  session,
  dialog,
  nativeImage,
  screen,
  globalShortcut,
} = require("electron");
const logger = require("./logger");
const displayShields = require("./displayShields");
const osLockdown = require("./osLockdown");
const appState = require("./appState");
const localeManager = require("./localeManager");
const { createLockdownGuard, releaseLock } = require("./lockdownGuard");
const { INTERVIEW_BASE_URL, DEVTOOLS_ENABLED } = require("../shared/constants");
const { CODE } = require("../shared/violationCodes");

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

/** @type {BrowserWindow | null} the locked window the interview runs in, created per interview */
let interviewWin = null;

/** @type {boolean} */
let isInterviewActive = false;

/** @type {ReturnType<typeof createLockdownGuard> | null} */
let lockdownGuard = null;

/** @type {(event: string, severity: string, meta?: {code?: string, category?: string|null, apps?: string[]}) => void} */
let reportViolation = () => {};

/** @type {string | null} base64 photo from identity verification */
let _candidatePhotoBase64 = null;

const LOAD_RETRY_DELAYS_MS = [3000, 5000, 10000, 20000, 30000];
// Failed loads before the "can't reach" page offers a way back to the dashboard.
const LEAVE_AFTER_FAILED_LOADS = 3;
const UNAVAILABLE_PAGE = "interview-unavailable.html";
// Long enough for the exit animation to finish, so re-entering doesn't race it.
const HTML_FULLSCREEN_RETRY_MS = 400;

let interviewUrl = null;
let pendingInjection = null;
let loadRetryTimer = null;
let loadRetryAttempt = 0;
let showingUnavailable = false;

const WEB_PREFERENCES = {
  preload: path.join(__dirname, "../../preload.js"),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  safeDialogs: true,
  navigateOnDragDrop: false,
};

/**
 * Creates and configures the main application window.
 * @param {(event: string, severity: string, meta?: {code?: string, category?: string|null, apps?: string[]}) => void} onViolation
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
    webPreferences: WEB_PREFERENCES,
  });

  win.maximize();

  const pageFiles = { login: "login.html", dashboard: "dashboard.html" };
  const pageFile = pageFiles[startPage] || pageFiles.login;
  win.loadFile(path.join(__dirname, "../../assets", pageFile));

  win.setMenuBarVisibility(false);

  reportViolation = onViolation;

  win.on("closed", () => {
    win = null;
  });
  // Hidden while an interview runs; its window owns the exit prompt.
  win.on("close", (e) => {
    if (isInterviewActive) {
      e.preventDefault();
      return;
    }
    appState.setQuitting();
  });

  _hardenWindow(win);
  _applyCSPHeaders();

  return win;
}

function _hardenWindow(target) {
  if (app.isPackaged) {
    target.webContents.on("devtools-opened", () => {
      target.webContents.closeDevTools();
      logger.warn("[window] DevTools open attempt blocked (packaged build)");
    });
  } else if (DEVTOOLS_ENABLED) {
    target.webContents.openDevTools({ mode: "right" });
  }
  _applyInputLockdown(target);
  _applyNavigationGuardrails(target);
}

/**
 * Built locked rather than locked afterwards: switching kiosk and fullscreen on
 * a framed, maximized window at runtime doesn't always stick (display scaling,
 * several monitors), and on macOS simple fullscreen keeps it out of its own Space.
 */
function _createInterviewWindow(display) {
  const target = new BrowserWindow({
    ...display.bounds,
    title: "",
    icon: nativeImage.createEmpty(),
    show: false,
    frame: false,
    kiosk: true,
    fullscreen: true,
    simpleFullscreen: process.platform === "darwin",
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    resizable: false,
    movable: false,
    fullscreenable: true,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  target.setMenuBarVisibility(false);
  // The site uses this to turn away app versions without this lockdown.
  target.webContents.setUserAgent(
    `${target.webContents.getUserAgent()} LetsHyreSecureInterview/${app.getVersion()}`
  );

  _hardenWindow(target);
  _applyInterviewWindowClose(target);
  _applyInterviewLoadHandling(target);
  _forwardInterviewConsole(target);

  target.on("closed", () => {
    if (interviewWin !== target) {
      return;
    }
    interviewWin = null;
    if (isInterviewActive) {
      logger.warn("[window] interview window closed while locked — releasing");
      _releaseLockdown();
    }
    if (!appState.isQuitting()) {
      _showMain();
      loadDashboard();
    }
  });
  return target;
}

function _showMain() {
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.show();
  }
}

function _closeInterviewWindow() {
  const target = interviewWin;
  interviewWin = null;
  if (target && !target.isDestroyed()) {
    target.destroy();
  }
}

function _onAltF4() {
  reportViolation("Attempted OS level Alt+F4 kill string", "high", { code: CODE.CLOSE_ATTEMPT });
  interviewWin?.close();
}

function _logLockdownState(target) {
  const displays = screen
    .getAllDisplays()
    .map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}${d.internal ? " internal" : ""}`)
    .join(", ");
  logger.info(
    `[lockdown] ${process.platform} ${os.release()} displays=[${displays}] ` +
      `kiosk=${target.isKiosk()} fullscreen=${target.isFullScreen()} topmost=${target.isAlwaysOnTop()}`
  );
}

/**
 * Locks the screen and loads the interview in its own window. Tokens, photo,
 * role and locale are injected into the site's sessionStorage on dom-ready,
 * before its scripts run.
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

  const display = screen.getDisplayMatching(win.getBounds());
  _closeInterviewWindow();
  interviewWin = _createInterviewWindow(display);

  lockdownGuard?.stop();
  lockdownGuard = createLockdownGuard(interviewWin, { onViolation: reportViolation, log: logger });
  lockdownGuard.start();

  const statements = [
    "sessionStorage.removeItem('interview_session');",
    "sessionStorage.removeItem('face_registered');",
    "sessionStorage.removeItem('face_registered_for');",
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
  showingUnavailable = false;
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;

  interviewWin.show();
  interviewWin.focus();
  win.hide();
  displayShields.start(display.id);
  osLockdown.start(interviewWin, reportViolation);
  if (!globalShortcut.isRegistered("Alt+F4")) {
    globalShortcut.register("Alt+F4", _onAltF4);
  }
  _logLockdownState(interviewWin);

  logger.info("[window] lockdown activated — navigating to interview");
  interviewWin.loadURL(url).catch(() => {});
}

/**
 * Lifts every part of the lockdown. The interview window stays open on the
 * result screen until the candidate leaves it.
 * @returns {Promise<void>} once the agent has let go of the keyboard and touchpad
 */
function _releaseLockdown() {
  isInterviewActive = false;
  lockdownGuard?.stop();
  lockdownGuard = null;
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
  interviewUrl = null;
  pendingInjection = null;
  displayShields.stop();
  if (globalShortcut.isRegistered("Alt+F4")) {
    globalShortcut.unregister("Alt+F4");
  }
  if (interviewWin && !interviewWin.isDestroyed()) {
    releaseLock(interviewWin);
    interviewWin.setBounds(screen.getDisplayMatching(interviewWin.getBounds()).workArea);
  }
  return osLockdown.stop();
}

/**
 * Lifts the lockdown once the interview site reports the session is over.
 * @param {string} reason - e.g. "completed", "auto-submitted", "terminated", "expired"
 * @returns {Promise<void>}
 */
function endInterview(reason) {
  if (!isInterviewActive) {
    logger.info("[window] endInterview called but interview was already inactive — skipping");
    return Promise.resolve();
  }
  logger.info(`[window] interview ended (reason: ${reason}) — window restrictions lifted`);
  return _releaseLockdown();
}

function _isInterviewPage(url) {
  return Boolean(INTERVIEW_BASE_URL) && String(url || "").startsWith(INTERVIEW_BASE_URL);
}

/** Reloads the interview after a failed load. The lockdown stays on throughout. */
function retryInterview() {
  if (!interviewWin || interviewWin.isDestroyed() || !isInterviewActive || !interviewUrl) {
    return;
  }
  clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
  logger.info("[window] retrying interview load");
  interviewWin.loadURL(interviewUrl).catch(() => {});
}

/**
 * Electron leaves a blank white page when a load fails, so a failed interview
 * load shows a local "can't reach the interview" page and keeps retrying.
 */
function _applyInterviewLoadHandling(target) {
  const wc = target.webContents;
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
    const query = loadRetryAttempt >= LEAVE_AFTER_FAILED_LOADS ? { query: { leave: "1" } } : {};
    wc.loadFile(path.join(__dirname, "../../assets", UNAVAILABLE_PAGE), query).catch(() => {});
    clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(retryInterview, delay);
  };

  wc.on("did-navigate", (_event, url, httpResponseCode) => {
    showingUnavailable = String(url).startsWith("file:") && String(url).includes(UNAVAILABLE_PAGE);
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
      _enterPageFullscreen(target);
    }
  });
}

/**
 * @param {string} dataUrl base64 data URL from identity verification
 * @returns {boolean} whether the interview will have a reference face
 */
function storeCandidatePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    logger.warn("[window] storeCandidatePhoto: invalid data URL, ignoring");
    return false;
  }
  _candidatePhotoBase64 = dataUrl;
  logger.info("[window] candidate photo stored for interview injection");
  return true;
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

const PAGE_FULLSCREEN_SCRIPT =
  "document.fullscreenElement ? 'already' : document.documentElement.requestFullscreen().then(() => 'ok', (e) => String(e && e.name))";

const KEYBOARD_LOCK_SCRIPT = `(async () => {
  if (!navigator.keyboard) return "Keyboard API unavailable";
  try {
    await navigator.keyboard.lock();
    return "ok";
  } catch (e) {
    return (e && e.name ? e.name : "Error") + ": " + (e && e.message ? e.message : String(e));
  }
})()`;

/**
 * Keyboard lock is what keeps the Windows key and Alt+Tab inside the page, and
 * it only holds while the page is fullscreen. The site can only ask for that
 * from a click, so the app does it as soon as the page loads.
 */
function _enterPageFullscreen(target) {
  if (
    target.isDestroyed() ||
    !isInterviewActive ||
    !_isInterviewPage(target.webContents.getURL())
  ) {
    return;
  }
  target.webContents
    .executeJavaScript(PAGE_FULLSCREEN_SCRIPT, true)
    .then((result) => {
      if (result !== "ok" && result !== "already") {
        logger.warn(`[window] page fullscreen refused: ${result}`);
      }
    })
    .catch((err) => logger.warn(`[window] page fullscreen failed: ${err?.message || err}`));
}

/** Blocks DevTools shortcuts, Alt+F4 and F11 during the interview, and locks system keys. */
function _applyInputLockdown(target) {
  target.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.meta && input.alt && input.key === "I");

    // Before the interview the candidate may need to leave the app to close other windows.
    const isAltF4 = input.alt && input.key === "F4" && isInterviewActive;
    const isFullscreenToggle = input.key === "F11" && isInterviewActive;
    // Reloading a finished interview makes the site start a new one outside lockdown.
    const isReload =
      (input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r")) &&
      !isInterviewActive &&
      _isInterviewPage(target.webContents.getURL());

    if ((isDevTools && !DEVTOOLS_ENABLED) || isAltF4 || isFullscreenToggle || isReload) {
      event.preventDefault();
    }
  });

  target.webContents.on("enter-html-full-screen", () => {
    if (!isInterviewActive || !_isInterviewPage(target.webContents.getURL())) {
      return;
    }
    target.webContents
      .executeJavaScript(KEYBOARD_LOCK_SCRIPT, true)
      .then((result) => {
        if (result === "ok") {
          logger.info("[window] keyboard lock on");
        } else if (String(result).startsWith("AbortError")) {
          // The site locks too; the later call holds and the earlier one aborts.
          logger.info("[window] keyboard lock held by the page's own lock() call");
        } else {
          logger.warn(`[window] keyboard lock failed: ${result}`);
        }
      })
      .catch((err) => logger.warn(`[window] keyboard lock failed: ${err?.message || err}`));
  });

  // Holding Esc leaves page fullscreen and with it the keyboard lock.
  target.webContents.on("leave-html-full-screen", () => {
    if (!isInterviewActive || !_isInterviewPage(target.webContents.getURL())) {
      return;
    }
    logger.warn("[window] interview left page fullscreen — entering it again");
    setTimeout(() => _enterPageFullscreen(target), HTML_FULLSCREEN_RETRY_MS);
  });
}

const CONSOLE_LOG_LIMIT = 300;

// The interview site's warnings and errors, so a proctoring problem a candidate
// saw can be traced from the app log. Capped so a noisy session can't flood it.
function _forwardInterviewConsole(target) {
  let forwarded = 0;
  target.webContents.on("did-navigate", () => {
    forwarded = 0;
  });
  target.webContents.on("console-message", ({ level, message, frame }) => {
    if (level !== "warning" && level !== "error") {
      return;
    }
    if (forwarded >= CONSOLE_LOG_LIMIT || !_isInterviewPage(frame?.url ?? "")) {
      return;
    }
    forwarded += 1;
    const text = String(message).slice(0, 500);
    if (level === "error") {
      logger.error(`[interview-console] ${text}`);
    } else {
      logger.warn(`[interview-console] ${text}`);
    }
  });
}

/** Only the interview site and local pages may load; window.open is always refused. */
function _applyNavigationGuardrails(target) {
  target.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(INTERVIEW_BASE_URL) && !url.startsWith("file://")) {
      logger.warn("[window] blocked navigation to:", url);
      event.preventDefault();
    }
  });

  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Confirms before closing during an interview. Minimize is held by lockdownGuard. */
function _applyInterviewWindowClose(target) {
  target.on("close", (e) => {
    if (!isInterviewActive) {
      return;
    }

    e.preventDefault();

    const modalStrings = _exitModalStrings();
    const choice = dialog.showMessageBoxSync(target, {
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
      appState.setQuitting();
      // Released first so a quit-time prompt is not hidden behind the locked window.
      _releaseLockdown().finally(() => app.quit());
    } else {
      logger.warn("[window] user dismissed close dialog during interview");
      reportViolation("Attempt to close interview window", "high", { code: CODE.CLOSE_ATTEMPT });
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

/** The window the candidate is looking at: the interview's while it is open. */
function getWindow() {
  return interviewWin && !interviewWin.isDestroyed() ? interviewWin : win;
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

function _loadMainPage(file, options) {
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, "../../assets", file), options);
  }
}

/** @param {"stale"|"dirty"|"scanning"} [reason] - why Continue sent the candidate back */
function loadSecurityCheck(reason) {
  _loadMainPage("preflight.html", reason ? { query: { reason } } : undefined);
}

/** The security check as a practice run from the dashboard. */
function loadPracticeCheck() {
  _loadMainPage("preflight.html", { query: { mode: "practice" } });
}

function loadLanguageSelectionPage() {
  _loadMainPage("language-selection.html");
}

function loadPermissionsPage() {
  _loadMainPage("permissions.html");
}

function loadIdentityVerificationPage() {
  _loadMainPage("identity-verification.html");
}

/**
 * Also where the candidate lands after the interview window closes.
 * @param {"startFailed"|"exhausted"} [note] - why they're back, shown on the dashboard
 */
function loadDashboard(note) {
  if (!isInterviewActive) {
    _closeInterviewWindow();
  }
  _showMain();
  _loadMainPage("dashboard.html", note ? { query: { note } } : undefined);
}

function isShowingUnavailablePage() {
  return isInterviewActive && showingUnavailable;
}

/** @returns {Promise<boolean>} true when the candidate chose to leave */
async function confirmLeaveStalledStart() {
  const target = getWindow();
  if (!target || target.isDestroyed()) {
    return false;
  }
  const bundle = localeManager.getTranslations(localeManager.getPreferred()) || {};
  const tr = (key, fallback) =>
    key.split(".").reduce((node, part) => node?.[part], bundle) || fallback;
  const { response } = await dialog.showMessageBox(target, {
    type: "warning",
    buttons: [
      tr("startWatchdog.wait", "Keep waiting"),
      tr("startWatchdog.leave", "Back to dashboard"),
    ],
    defaultId: 0,
    cancelId: 0,
    title: tr("startWatchdog.title", "Your interview hasn't started"),
    message: tr("startWatchdog.message", "Your interview is taking longer than expected to start."),
    detail: tr(
      "startWatchdog.detail",
      "You can keep waiting, or go back to the dashboard and try again later."
    ),
    noLink: true,
  });
  return response === 1;
}

function loadRoleSelectionPage() {
  _loadMainPage("role-selection.html");
}

function loadHowItWorksPage() {
  _loadMainPage("how-it-works.html");
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
  loadPracticeCheck,
  loadLanguageSelectionPage,
  loadPermissionsPage,
  loadIdentityVerificationPage,
  loadRoleSelectionPage,
  loadHowItWorksPage,
  getWindow,
  minimizeWindow,
  getIsInterviewActive,
  isShowingUnavailablePage,
  confirmLeaveStalledStart,
};
