/**
 * src/renderer/recorder.js
 * ─────────────────────────
 * Runs inside the hidden recorder BrowserWindow.
 * Receives a screen source ID from main, opens screen + mic streams,
 * and sends 5-second video/webm chunks back to main via IPC.
 *
 * Flow:
 *   main → "recorder:init" { sourceId }
 *   renderer: getUserMedia (screen) + getUserMedia (mic) → merge → MediaRecorder
 *   renderer → "recorder:ready"   (recording confirmed started)
 *   renderer → "recorder:chunk"   (Uint8Array, every CHUNK_INTERVAL_MS)
 *   main → "recorder:stop"
 *   renderer: mediaRecorder.stop() → final chunk → streams released
 */

"use strict";

const CHUNK_INTERVAL_MS = 5000;

let mediaRecorder = null;
let screenStream = null;
let micStream = null;

window.recorderBridge.onInit(async ({ sourceId }) => {
  try {
    // Screen video — use chromeMediaSource to capture the primary display.
    // audio:false here because chromeMediaSource audio = system loopback (not mic).
    screenStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 15,
        },
      },
      audio: false,
    });

    // Mic audio — separate getUserMedia call for reliable cross-platform mic capture.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 44100,
      },
      video: false,
    });

    // Merge screen video + mic audio into one stream for MediaRecorder.
    const merged = new MediaStream([
      ...screenStream.getVideoTracks(),
      ...micStream.getAudioTracks(),
    ]);

    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : "video/webm";

    mediaRecorder = new MediaRecorder(merged, { mimeType: mime });

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        const buf = await e.data.arrayBuffer();
        window.recorderBridge.sendChunk(new Uint8Array(buf));
      }
    };

    mediaRecorder.onerror = (e) => {
      window.recorderBridge.sendError(e.error?.message || "MediaRecorder error");
    };

    mediaRecorder.start(CHUNK_INTERVAL_MS);
    window.recorderBridge.sendReady();
  } catch (err) {
    window.recorderBridge.sendError(err.message || "getUserMedia failed");
    _releaseStreams();
  }
});

window.recorderBridge.onStop(() => {
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  } catch { /* ignore */ }
  _releaseStreams();
});

function _releaseStreams() {
  screenStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  micStream = null;
}
