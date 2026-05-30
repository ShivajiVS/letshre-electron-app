const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const path = require("path");
const startDetection = require("./src/detector/systemChecks");

let win;
let deepLinkUrl = null;

// =====================
// SINGLE INSTANCE LOCK (IMPORTANT)
// =====================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
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

      let newUrl = buildInterviewUrl(params);

      win.loadURL(newUrl);
      win.focus();
    }
  }
});

// =====================
// APP READY
// =====================
app.whenReady().then(async () => {
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
  let finalUrl = "https://interview.letshyre.com";

  // 🔥 Apply deep link if available
  if (deepLinkUrl) {
    const params = getParams(deepLinkUrl);
    finalUrl = buildInterviewUrl(params);
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),

      // 🔐 Security
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(finalUrl);

  win.setMenuBarVisibility(false);

  // 🔥 Block DevTools
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I")
    ) {
      event.preventDefault();
    }
  });

  // 🔥 Restrict navigation
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://interview.letshyre.com")) {
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
    safeViolation("Window lost focus (ALT+TAB)", "high");
  });

  win.on("minimize", (e) => {
    e.preventDefault();
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
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
