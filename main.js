const { app, BrowserWindow, session, desktopCapturer, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const startDetection = require("./src/detector/systemChecks");

let win;
let deepLinkUrl = null;
let currentInterviewUrl = "https://interview.letshyre.com";

// =====================
// IPC HANDLERS FOR VIOLATION SCREEN
// =====================
ipcMain.on("quit-app", () => {
  app.isQuiting = true;
  app.quit();
});

ipcMain.on("recheck-system", () => {
  if (win) {
    // Reset detection state
    if (startDetection.resetState) startDetection.resetState();
    
    // Reload interview
    win.loadURL(currentInterviewUrl);
  }
});

// =====================
// SINGLE INSTANCE LOCK (IMPORTANT)
// =====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.isQuiting = true;
  app.quit();
}

// =====================
// HANDLE DEEP LINK (Windows - First Launch)
// =====================
if (process.platform === "win32") {
  deepLinkUrl = process.argv.find((arg) => arg.startsWith("letshyre://"));
}

// =====================
// REGISTER PROTOCOL
// =====================
app.setAsDefaultProtocolClient("letshyre");

// =====================
// HANDLE SECOND INSTANCE (WHEN APP ALREADY OPEN)
// =====================
app.on("second-instance", (event, argv) => {
  const url = argv.find((arg) => arg.startsWith("letshyre://"));

  if (url) {
    deepLinkUrl = url;

    if (win) {
      const params = getParams(url);

      currentInterviewUrl = buildInterviewUrl(params);

      win.loadURL(currentInterviewUrl);
      win.focus();
    }
  }
});

// =====================
// APP READY
// =====================
app.whenReady().then(async () => {

  // 🔥 AGGRESSIVELY BLOCK ALT+F4 AT OS LEVEL
  globalShortcut.register("Alt+F4", () => {
    safeViolation("Attempted to close with ALT+F4", "high");
  });

  // 🔥 Enable screen capture
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });

        callback({ video: sources.length ? sources[0] : null });
      } catch (e) {
        console.log("Screen capture error:", e);
        callback({ video: null });
      }
    },
  );

  createWindow();
});

// =====================
// EXTRACT PARAMS FROM DEEP LINK
// =====================
function getParams(url) {
  try {
    const parsed = new URL(url);

    return {
      accessToken: parsed.searchParams.get("ac"),
      refreshToken: parsed.searchParams.get("rc"),
    };
  } catch (e) {
    console.log("URL parse error:", e);
    return {};
  }
}

// =====================
// BUILD FINAL INTERVIEW URL
// =====================
function buildInterviewUrl(params) {
  let url = "https://interview.letshyre.com";

  if (params.accessToken) {
    url += `?ac=${encodeURIComponent(params.accessToken)}`;

    if (params.refreshToken) {
      url += `&rc=${encodeURIComponent(params.refreshToken)}`;
    }
  }

  return url;
}

// =====================
// CREATE WINDOW
// =====================
function createWindow() {
  currentInterviewUrl = "https://interview.letshyre.com";

  // 🔥 Apply deep link if available
  if (deepLinkUrl) {
    const params = getParams(deepLinkUrl);
    currentInterviewUrl = buildInterviewUrl(params);
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true, // 🔥 Prevents Win+D / Show Desktop
    type: "screen-saver", // 🔥 Highest priority window type
    autoHideMenuBar: true,
    minimizable: false, // 🔥 Completely disable minimization at OS level
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),

      // 🔐 Security
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(currentInterviewUrl);

  win.setMenuBarVisibility(false);

  // 🔥 Block DevTools and Alt+F4
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.alt && input.key === "F4")
    ) {
      event.preventDefault();
    }
  });

  // 🔥 Restrict navigation (allow local file load for violation screen)
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://interview.letshyre.com") && !url.startsWith("file://")) {
      event.preventDefault();
    }
  });

  // 🔥 Block new windows
  win.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  // =====================
  // SECURITY EVENTS
  // =====================

  win.on("blur", () => {
    if (win) {
      win.show();
      win.focus(); // 🔥 Aggressively steal focus back
    }
    safeViolation("Window lost focus (ALT+TAB)", "high");
  });

  win.on("minimize", (e) => {
    e.preventDefault();
    if (win) {
      win.restore(); // Force it to stay open
      win.focus();
    }
    safeViolation("Window minimize attempt", "high");
  });

  win.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      safeViolation("Attempt to close interview", "high");
    }
  });

  // 🔥 Start detection
  try {
    startDetection.start(win);
  } catch (e) {
    console.log("Detection start failed:", e);
  }
}

// =====================
// SAFE VIOLATION WRAPPER
// =====================
function safeViolation(event, severity) {
  try {
    if (startDetection.sendViolation) {
      startDetection.sendViolation(win, event, severity);
    }
  } catch (e) {
    console.log("Violation error:", e);
  }
}

// =====================
// CLEAN EXIT
// =====================
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.isQuiting = true;
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
