/**
 * preload-recorder.js
 * ────────────────────
 * Minimal context bridge for the hidden recorder BrowserWindow.
 * Exposes only the IPC channels the recorder renderer needs —
 * no auth, no app control, nothing else.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recorderBridge", {
  onInit: (cb) => ipcRenderer.on("recorder:init", (_, data) => cb(data)),
  onStop: (cb) => ipcRenderer.on("recorder:stop", () => cb()),
  sendReady: () => ipcRenderer.send("recorder:ready"),
  sendChunk: (uint8Array) => ipcRenderer.send("recorder:chunk", uint8Array),
  sendError: (msg) => ipcRenderer.send("recorder:error", msg),
});
