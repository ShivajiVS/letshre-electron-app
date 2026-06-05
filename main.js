const {
  app,
  BrowserWindow,
  session,
  desktopCapturer,
  ipcMain,
  globalShortcut,
} = require("electron");
const path = require("path");
const startDetection = require("./src/detector/systemChecks");

let win;
let deepLinkUrl = null;
let currentInterviewUrl = "https://interview.letshyre.com";
let isInterviewActive = false;

// SINGLE INSTANCE LOCK (Must run first)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.isQuiting = true;
  app.quit();
} else {
  // Handle second instance (Windows/Linux)
  app.on("second-instance", (event, argv) => {
    const url = argv.find((arg) => arg.startsWith("letshyre://"));
    if (url) {
      handleIncomingProtocol(url);
    }
  });
}

// Handle macOS Protocol launching
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleIncomingProtocol(url);
});

// Register custom protocol
app.setAsDefaultProtocolClient("letshyre");

// GLOBAL PROTOCOL ROUTER
function handleIncomingProtocol(url) {
  deepLinkUrl = url;
  const params = getParams(url);
  currentInterviewUrl = buildInterviewUrl(params);

  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();

    // ⚠️ Security Rule: If they are already mid-interview, dynamically
    // re-routing them away could be an exploit or crash state.
    if (isInterviewActive) {
      safeViolation("Attempted protocol swap during active interview", "high");
      win.loadURL(currentInterviewUrl);
    } else {
      // If they are still in preflight, just update the target URL state silently.
      console.log(
        "Updated target interview destination to:",
        currentInterviewUrl,
      );
    }
  }
}

// IPC HANDLERS (Moved to Global Scope)
ipcMain.on("quit-app", () => {
  app.isQuiting = true;
  app.quit();
});

ipcMain.on("recheck-system", () => {
  if (win) {
    if (startDetection.resetState) startDetection.resetState();
    // Re-load the local preflight instead of jumping straight to the web URL
    win.loadFile(path.join(__dirname, "assets/preflight.html"));
  }
});

ipcMain.handle("run-preflight-scans", async () => {
  return await startDetection.runChecksOnce();
});

ipcMain.on("proceed-to-interview", () => {
  if (win) {
    isInterviewActive = true;

    // 🔥 Absolute Lock down configuration
    win.setAlwaysOnTop(true, "screen-saver");
    win.setKiosk(true);
    win.setFullScreen(true);
    win.setMinimizable(false);

    win.loadURL(currentInterviewUrl);

    try {
      startDetection.start(win);
    } catch (e) {
      console.log("Detection start failed:", e);
    }
  }
});

// WINDOW MANAGEMENT
function createWindow() {
  // Handle Windows CLI deep-link arguments on initial boot
  if (process.platform === "win32" && !deepLinkUrl) {
    const url = process.argv.find((arg) => arg.startsWith("letshyre://"));
    if (url) deepLinkUrl = url;
  }

  if (deepLinkUrl) {
    const params = getParams(deepLinkUrl);
    currentInterviewUrl = buildInterviewUrl(params);
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.maximize();
  win.loadFile(path.join(__dirname, "assets/preflight.html"));
  win.setMenuBarVisibility(false);

  // Keyboard Lockdown (F12, DevTools, Alt+F4)
  win.webContents.on("before-input-event", (event, input) => {
    const isDevTools =
      input.key === "F12" ||
      (input.control && input.shift && input.key === "I") ||
      (input.meta && input.alt && input.key === "I");
    const isAltF4 = input.alt && input.key === "F4";

    if (isDevTools || isAltF4) {
      event.preventDefault();
    }
  });

  // Navigation Guardrails
  win.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith("https://interview.letshyre.com") &&
      !url.startsWith("file://")
    ) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(() => {
    return { action: "deny" };
  });

  // Window Event Protections
  win.on("minimize", (e) => {
    if (!isInterviewActive) return;
    e.preventDefault();
    win.restore();
    win.focus();
    safeViolation("Window minimize attempt", "high");
  });

  win.on("close", (e) => {
    if (!app.isQuiting && isInterviewActive) {
      e.preventDefault();
      safeViolation("Attempt to close interview window", "high");
    }
  });
}

// LIFECYCLE INITIALIZATION
app.whenReady().then(async () => {
  // Register OS level block for Alt+F4
  globalShortcut.register("Alt+F4", () => {
    if (isInterviewActive) {
      safeViolation("Attempted OS level Alt+F4 kill string", "high");
    }
  });

  // Screen Capture Core Config
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        callback({ video: sources.length ? sources[0] : null });
      } catch (e) {
        console.log("Screen capture handling error:", e);
        callback({ video: null });
      }
    },
  );

  createWindow();
});

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

function safeViolation(event, severity) {
  try {
    if (startDetection.sendViolation && win) {
      startDetection.sendViolation(win, event, severity);
    }
  } catch (e) {
    console.log("Violation telemetry generation failure:", e);
  }
}

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
