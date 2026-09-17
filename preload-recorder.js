/**
 * Bridge for the hidden recorder window. Recorder channels only — no auth, no app control.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { IPC } = require("./src/shared/constants");

contextBridge.exposeInMainWorld("recorderBridge", {
  onInit: (cb) => ipcRenderer.on(IPC.RECORDER_INIT, (_, data) => cb(data)),
  onStop: (cb) => ipcRenderer.on(IPC.RECORDER_STOP, () => cb()),
  onSetBitrate: (cb) => ipcRenderer.on(IPC.RECORDER_SET_BITRATE, (_, bps) => cb(bps)),
  sendReady: () => ipcRenderer.send(IPC.RECORDER_READY),
  sendChunk: (uint8Array) => ipcRenderer.send(IPC.RECORDER_CHUNK, uint8Array),
  sendStopped: () => ipcRenderer.send(IPC.RECORDER_STOPPED),
  sendError: (msg) => ipcRenderer.send(IPC.RECORDER_ERROR, msg),
});
