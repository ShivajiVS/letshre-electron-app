const {
  app,
  BrowserWindow,
  session,
  desktopCapturer,
  ipcMain,
  globalShortcut,
} = require("electron");
const path = require("path");
const { exec, spawn } = require("child_process");
const http = require("http");
const startDetection = require("./src/detector/systemChecks");

let win;
let deepLinkUrl = null;
let currentInterviewUrl = "https://interview.letshyre.com";
let currentAccessToken = null;
let isInterviewActive = false;
let agentProcess = null;          // reference to the spawned agent binary
const { autoUpdater } = require("electron-updater");

// ─────────────────────────────────────────────────────────
//  AGENT BINARY — resolve path for packaged vs. dev
// ─────────────────────────────────────────────────────────
function getAgentPath() {
  const binName = process.platform === "win32" ? "agent.exe" : "agent";
  if (app.isPackaged) {
    // In production the binary lives in the app's resources folder
    return path.join(process.resourcesPath, binName);
  }
  // During development use the local resources/ folder
  return path.join(__dirname, "resources", binName);
}

/** Spawn the Python security agent and keep a reference to it. */
function spawnAgent() {
  const agentPath = getAgentPath();
  try {
    agentProcess = spawn(agentPath, [], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    agentProcess.stdout.on("data", (d) =>
      console.log("[agent]", d.toString().trim())
    );
    agentProcess.stderr.on("data", (d) =>
      console.error("[agent:err]", d.toString().trim())
    );
    agentProcess.on("exit", (code) => {
      console.warn(`[agent] exited with code ${code}`);
      agentProcess = null;
    });

    console.log(`[agent] spawned from ${agentPath}`);
  } catch (e) {
    console.error("[agent] failed to spawn:", e.message);
  }
}

/**
 * Poll /ping every 500 ms for up to `maxMs` ms.
 * Resolves true if the agent responds, false on timeout.
 */
function waitForAgent(maxMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    function attempt() {
      const req = http.get("http://127.0.0.1:9999/ping", (res) => {
        resolve(res.statusCode === 200);
      });
      req.setTimeout(400, () => {
        req.destroy();
        if (Date.now() - started < maxMs) {
          setTimeout(attempt, 500);
        } else {
          console.warn("[agent] did not respond within", maxMs, "ms");
          resolve(false);
        }
      });
      req.on("error", () => {
        if (Date.now() - started < maxMs) {
          setTimeout(attempt, 500);
        } else {
          resolve(false);
        }
      });
    }
    attempt();
  });
}

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
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('letshyre', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('letshyre');
}

// GLOBAL PROTOCOL ROUTER
function handleIncomingProtocol(url) {
  deepLinkUrl = url;
  const params = getParams(url);
  currentAccessToken = params.accessToken || null;
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

// 🔥 KILLABLE APPS WHITELIST — Only these can be force-closed from the UI
const KILLABLE_APPS = [
  // Meeting Apps
  "zoom.exe", "teams.exe", "ms-teams.exe", "msteams.exe", "webex.exe", "gotomeeting.exe", "skype.exe",
  "zoom.app", "zoom.us.app", "teams.app", "microsoft teams.app", "webex.app", "webex meetings.app", "gotomeeting.app", "skype.app",

  // Screen Sharing / Recording
  "obs64.exe", "obs32.exe", "obs-studio.exe", "discord.exe", "slack.exe", "anydesk.exe", "teamviewer.exe", "bandicam.exe", "camtasia.exe", "snagit.exe",
  "obs.app", "obs studio.app", "discord.app", "slack.app", "anydesk.app", "teamviewer.app", "camtasia.app", "snagit.app",

  // Casting / Mirroring
  "scrcpy.exe", "miracast.exe", "apowermirror.exe", "letsview.exe",
  "scrcpy", "apowermirror.app", "letsview.app",

  // Browsers
  "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe",
  "google chrome.app", "microsoft edge.app", "firefox.app", "safari.app", "opera.app", "brave.app", "vivaldi.app",
];

function killSingleProcess(processName) {
  return new Promise((resolve) => {
    if (!KILLABLE_APPS.includes(processName.toLowerCase())) {
      return resolve({ success: false, error: "Process not in blocked list", processName });
    }

    let cmd;
    if (process.platform === "darwin") {
      const appName = processName.replace(".app", "");
      cmd = `pkill -f "${appName}"`;
    } else {
      cmd = `taskkill /IM "${processName}" /F /T`;
    }

    exec(cmd, (err) => {
      if (err) {
        console.log(`Failed to kill ${processName}:`, err.message);
        resolve({ success: false, error: err.message, processName });
      } else {
        console.log(`Successfully killed ${processName}`);
        resolve({ success: true, processName });
      }
    });
  });
}

// Kill a single blocked background app
ipcMain.handle("kill-blocked-app", async (event, processName) => {
  return await killSingleProcess(processName);
});

// Kill ALL blocked background apps at once
ipcMain.handle("kill-all-blocked-apps", async (event, processNames) => {
  const results = [];
  for (const name of processNames) {
    const result = await killSingleProcess(name);
    results.push(result);
  }
  return results;
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
      startDetection.start(win, currentAccessToken);
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
    currentAccessToken = params.accessToken || null;
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
      safeViolation("Attempt to close interview window", "high");
    }
  });
}

// LIFECYCLE INITIALIZATION
app.whenReady().then(async () => {
  autoUpdater.checkForUpdatesAndNotify();

  // ── Spawn the security agent binary ──────────────────────
  spawnAgent();
  const agentReady = await waitForAgent(6000);
  if (agentReady) {
    console.log("[agent] ready ✅");
  } else {
    console.warn("[agent] not responding — continuing without deep detection");
  }

  // Register OS level block for Alt+F4
  globalShortcut.register("Alt+F4", () => {
    if (isInterviewActive) {
      safeViolation("Attempted OS level Alt+F4 kill string", "high");
      setTimeout(() => app.quit(), 500); // Give it a moment to send the violation
    } else {
      app.quit();
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
      startDetection.sendViolation(win, event, severity, currentAccessToken);
    }
  } catch (e) {
    console.log("Violation telemetry generation failure:", e);
  }
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // Cleanly terminate the agent process
  if (agentProcess) {
    try {
      agentProcess.kill();
    } catch (e) {
      console.warn("[agent] kill failed:", e.message);
    }
  }
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
