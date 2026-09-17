/**
 * Runs inside the hidden recorder window.
 *   init { sourceId, videoBitsPerSecond } → capture screen + mic → MediaRecorder (1 s timeslices)
 *   → webmChunker cuts ~15 s independently decodable WebM chunks → main uploads them.
 *
 * A bitrate change starts a fresh MediaRecorder: it cannot be retuned while
 * running. Each recorder segment gets its own chunker, since its WebM header differs.
 */

"use strict";

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const CHUNK_TARGET_MS = 15000;
const TIMESLICE_MS = 1000;
const AUDIO_BITS_PER_SECOND = 64_000;

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
      buf[i] === CLUSTER_ID[0] &&
      buf[i + 1] === CLUSTER_ID[1] &&
      buf[i + 2] === CLUSTER_ID[2] &&
      buf[i + 3] === CLUSTER_ID[3]
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** Emits the init segment + complete Clusters as standalone WebM chunks. */
function createWebmChunker({ targetMs, onChunk }) {
  let init = null;
  let tail = new Uint8Array(0);
  let lastEmit = 0;

  const emit = (uptoOffset) => {
    onChunk(_concat(init, tail.slice(0, uptoOffset)));
    tail = tail.slice(uptoOffset);
    lastEmit = Date.now();
  };

  return {
    push(arrayBuffer) {
      tail = _concat(tail, new Uint8Array(arrayBuffer));

      if (!init) {
        const offsets = _clusterOffsets(tail);
        if (offsets.length === 0) {
          return;
        }
        init = tail.slice(0, offsets[0]);
        tail = tail.slice(offsets[0]);
        lastEmit = Date.now();
      }

      if (Date.now() - lastEmit < targetMs) {
        return;
      }

      // The last Cluster may still be receiving bytes.
      const offsets = _clusterOffsets(tail);
      if (offsets.length >= 2) {
        emit(offsets[offsets.length - 1]);
      }
    },

    flush() {
      if (!init || tail.length === 0) {
        return;
      }
      onChunk(_concat(init, tail));
      tail = new Uint8Array(0);
    },
  };
}

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMime() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

let screenStream = null;
let micStream = null;
let mergedStream = null;
let mimeType = "";
let activeSegment = null;

// Segments flush one after another so chunks always reach main in recording order.
let flushChain = Promise.resolve();

if (!window.recorderBridge) {
  // No bridge to report over; main's readiness watchdog surfaces this.
  console.error("[recorder] recorderBridge is undefined — preload-recorder.js did not load");
}

function _startSegment(videoBitsPerSecond) {
  const chunker = createWebmChunker({
    targetMs: CHUNK_TARGET_MS,
    onChunk: (uint8Array) => window.recorderBridge.sendChunk(uint8Array),
  });

  const recorder = new MediaRecorder(mergedStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });

  let pushes = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) {
      return;
    }
    pushes = pushes
      .then(() => e.data.arrayBuffer())
      .then((buf) => chunker.push(buf))
      .catch((err) => console.error("[recorder] chunker push failed:", err));
  };

  let markStopped;
  const stopped = new Promise((resolve) => {
    markStopped = resolve;
  });
  recorder.onstop = () => markStopped();

  recorder.onerror = (e) => {
    window.recorderBridge.sendError(e.error?.message || "MediaRecorder error");
  };

  recorder.start(TIMESLICE_MS);

  return {
    finish() {
      if (recorder.state === "inactive") {
        markStopped();
      } else {
        recorder.stop();
      }
      flushChain = flushChain
        .then(() => stopped)
        .then(() => pushes)
        .then(() => chunker.flush())
        .catch((err) => console.error("[recorder] segment flush failed:", err));
      return flushChain;
    },
  };
}

window.recorderBridge?.onInit(async ({ sourceId, videoBitsPerSecond }) => {
  try {
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

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100 },
        video: false,
      });
    } catch {
      // No mic — record the screen alone.
    }

    mergedStream = new MediaStream([
      ...screenStream.getVideoTracks(),
      ...(micStream ? micStream.getAudioTracks() : []),
    ]);
    mimeType = pickMime();

    activeSegment = _startSegment(videoBitsPerSecond);
    window.recorderBridge.sendReady();
  } catch (err) {
    window.recorderBridge.sendError(err.message || "getUserMedia failed");
    _releaseStreams();
  }
});

window.recorderBridge?.onSetBitrate((videoBitsPerSecond) => {
  if (!activeSegment) {
    return;
  }
  // Start the next segment before stopping this one so no frames fall between them.
  const previous = activeSegment;
  try {
    activeSegment = _startSegment(videoBitsPerSecond);
  } catch (err) {
    console.error("[recorder] bitrate change failed — keeping current bitrate:", err);
    return;
  }
  previous.finish();
});

window.recorderBridge?.onStop(async () => {
  const segment = activeSegment;
  activeSegment = null;
  if (segment) {
    await segment.finish();
  }
  window.recorderBridge.sendStopped();
  _releaseStreams();
});

function _releaseStreams() {
  screenStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  micStream = null;
  mergedStream = null;
}
