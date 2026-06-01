const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  quitApp: () => ipcRenderer.send("quit-app"),
  recheckSystem: () => ipcRenderer.send("recheck-system"),
  runPreflight: () => ipcRenderer.invoke("run-preflight-scans"),
  proceedToInterview: () => ipcRenderer.send("proceed-to-interview"),
});

// 🔥 Use capture phase (true) to intercept events BEFORE the webpage can stop them
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
}, true);

document.addEventListener("keydown", (e) => {
  // Block Copy (C), Paste (V), View Source (U) on both Windows (Ctrl) and Mac (Cmd)
  if ((e.ctrlKey || e.metaKey) && ["c", "v", "u"].includes(e.key.toLowerCase())) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Block PrintScreen key
  if (e.key === "PrintScreen") {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
