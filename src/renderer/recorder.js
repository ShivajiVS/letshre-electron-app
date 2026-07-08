/**
 * src/renderer/recorder.js
 * ─────────────────────────
 * Runs inside the hidden recorder BrowserWindow.
 *
 * Pipeline (mirrors ScreenRecordingContext.jsx from the interview site):
 *   main → "recorder:init" { sourceId }
 *   → getUserMedia (screen via chromeMediaSource) + getUserMedia (mic)
 *   → single continuous MediaRecorder (1s timeslice)
 *   → webmChunker re-chunks raw bytes into independently-decodable WebM blobs
 *     (initSegment + complete Clusters, ~15s each)
 *   → each complete chunk: "recorder:chunk" Uint8Array → main → uploadVideoChunk
 *   → on stop: flush final clusters → "recorder:stopped" → main → completeVideoUpload
 */

"use strict";

// ─── WebM chunker (mirrors src/lib/webmChunker.js from the interview site) ───
// Finds Cluster element boundaries (0x1F43B675) in the raw MediaRecorder stream
// and emits initSegment + complete Clusters as independently-decodable WebM blobs.

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const CHUNK_TARGET_MS = 15000; // ~15 s per upload chunk (matches RECORDING_SEGMENT_MS)
const TIMESLICE_MS    = 1000;  // MediaRecorder fires ondataavailable every 1s

function _concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function _clusterOffsets(buf) {
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i]     === CLUSTER_ID[0] &&
      buf[i + 1] === CLUSTER_ID[1] &&
      buf[i + 2] === CLUSTER_ID[2] &&
      buf[i + 3] === CLUSTER_ID[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

function createWebmChunker({ targetMs, onChunk }) {
  let init      = null;             // Uint8Array — WebM header, prepended to every chunk
  let tail      = new Uint8Array(0); // bytes from first un-emitted cluster onward
  let lastEmit  = 0;

  const emit = (uptoOffset) => {
    const clusters = tail.slice(0, uptoOffset);
    onChunk(_concat(init, clusters)); // Uint8Array — no Blob, no async conversion
    tail     = tail.slice(uptoOffset);
    lastEmit = Date.now();
  };

  return {
    push(arrayBuffer) {
      tail = _concat(tail, new Uint8Array(arrayBuffer));

      // Capture init segment once: everything before the first Cluster.
      if (!init) {
        const offsets = _clusterOffsets(tail);
        if (offsets.length === 0) return; // header still arriving
        init     = tail.slice(0, offsets[0]);
        tail     = tail.slice(offsets[0]);
        lastEmit = Date.now();
      }

      if (Date.now() - lastEmit < targetMs) return;

      // Emit all COMPLETE clusters (everything before the last cluster start —
      // the last one may still be receiving bytes).
      const offsets = _clusterOffsets(tail);
      if (offsets.length >= 2) {
        emit(offsets[offsets.length - 1]);
      }
    },

    flush() {
      if (!init || tail.length === 0) return;
      onChunk(_concat(init, tail)); // Uint8Array — same as emit, no Blob
      tail = new Uint8Array(0);
    },
  };
}

// ─── MIME selection ───────────────────────────────────────────────────────────

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMime() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

// ─── Recorder state ───────────────────────────────────────────────────────────

let mediaRecorder = null;
let screenStream  = null;
let micStream     = null;

// ─── Main flow ────────────────────────────────────────────────────────────────

// If the preload never loaded (e.g. preload-recorder.js missing from the packaged
// asar), window.recorderBridge is undefined and nothing below can run. There is no
// bridge to report the error over, so bail loudly to the console — the main-side
// readiness watchdog is the real safety net that surfaces this to the user.
if (!window.recorderBridge) {
  console.error(
    "[recorder] recorderBridge is undefined — preload-recorder.js did not load; recording cannot start"
  );
}

window.recorderBridge?.onInit(async ({ sourceId }) => {
  try {
    // Screen video — chromeMediaSource captures the OS-level display silently.
    screenStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource:   "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth:  1920,
          maxHeight: 1080,
          maxFrameRate: 15,
        },
      },
      audio: false,
    });

    // Mic audio — separate call for reliable cross-platform mic capture.
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100 },
        video: false,
      });
    } catch {
      // Mic unavailable — proceed with screen-only recording.
    }

    const merged = new MediaStream([
      ...screenStream.getVideoTracks(),
      ...(micStream ? micStream.getAudioTracks() : []),
    ]);

    const mime    = pickMime();
    let chunkChain = Promise.resolve();

    const chunker = createWebmChunker({
      targetMs: CHUNK_TARGET_MS,
      // onChunk receives a Uint8Array directly (chunker no longer wraps in Blob).
      // ipcRenderer.send is synchronous — the message is enqueued immediately,
      // so no async step and no Promise needed here.
      onChunk: (uint8Array) => {
        window.recorderBridge.sendChunk(uint8Array);
      },
    });

    mediaRecorder = new MediaRecorder(merged, mime ? { mimeType: mime } : {});

    // Serialise byte pushes so the chunker always receives bytes in order.
    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      chunkChain = chunkChain
        .then(() => e.data.arrayBuffer())
        .then((buf) => chunker.push(buf))
        .catch((err) => console.error("[recorder] chunker push failed:", err));
    };

    mediaRecorder.onstop = async () => {
      await chunkChain;                    // wait for all in-flight push() calls
      chunker.flush();                     // sendChunk() enqueued synchronously
      window.recorderBridge.sendStopped(); // arrives at main after all chunks (FIFO)
      _releaseStreams();
    };

    mediaRecorder.onerror = (e) => {
      window.recorderBridge.sendError(e.error?.message || "MediaRecorder error");
    };

    mediaRecorder.start(TIMESLICE_MS);
    window.recorderBridge.sendReady();
  } catch (err) {
    window.recorderBridge.sendError(err.message || "getUserMedia failed");
    _releaseStreams();
  }
});

window.recorderBridge?.onStop(() => {
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // → ondataavailable (final) → onstop → flush → sendStopped
    } else {
      window.recorderBridge.sendStopped();
      _releaseStreams();
    }
  } catch {
    window.recorderBridge.sendStopped();
    _releaseStreams();
  }
});

function _releaseStreams() {
  screenStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  micStream    = null;
}
