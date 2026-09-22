"use strict";

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  if (window.t) {
    return window.t(key, params);
  }
  if (!params) {
    return fallback;
  }
  return fallback.replace(/\{(\w+)\}/g, (match, token) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
  );
}

// authManager API_ERROR codes → i18n keys. Raw backend messages are only logged in main.
const VOICE_ERROR_KEYS = {
  network_error: ["identity.networkError", "Network error. Please try again."],
  timeout: ["identity.networkError", "Network error. Please try again."],
  session_expired: [
    "identity.sessionExpired",
    "Your session has expired. Please restart the app and sign in again.",
  ],
  server_error: ["identity.voiceSubmitFailed", "Voice submission failed. Please try again."],
  request_failed: ["identity.voiceSubmitFailed", "Voice submission failed. Please try again."],
  unknown: ["identity.voiceSubmitFailed", "Voice submission failed. Please try again."],
};
const PHOTO_ERROR_KEYS = {
  network_error: ["identity.networkError", "Network error. Please try again."],
  timeout: ["identity.networkError", "Network error. Please try again."],
  session_expired: [
    "identity.sessionExpired",
    "Your session has expired. Please restart the app and sign in again.",
  ],
  server_error: ["identity.faceVerificationFailed", "Face verification failed. Please try again."],
  request_failed: [
    "identity.faceVerificationFailed",
    "Face verification failed. Please try again.",
  ],
  unknown: ["identity.faceVerificationFailed", "Face verification failed. Please try again."],
};

const MIN_RECORDING_MS = 3000;
const MAX_RECORDING_MS = 30000;
// Peak RMS below this for a whole take means a muted or dead mic, not a quiet voice.
const SILENCE_RMS = 0.008;

document.addEventListener("DOMContentLoaded", async () => {
  let audioBlob = null;
  let audioMimeType = "";
  let audioURL = null;
  const audioPlayer = document.getElementById("iv-audio-player");
  let isPlaying = false;
  let mediaRecorder = null;
  let audioChunks = [];
  let capturedDataUrl = null;
  let videoStream = null;
  let profilePhotoSrc = "";
  let recordingMeta = null;
  let recordingStartedAt = 0;
  let recordingTimer = null;
  let meter = null;

  let currentStep = 1;
  let voiceSubmitting = false;
  let photoVerifying = false;
  let beginLoading = false;
  let lastResultMatch = null;
  let lastError = null;

  const topBack = document.getElementById("btn-back");
  const errorBanner = document.getElementById("iv-error");
  const errorText = document.getElementById("iv-error-text");

  const sidebarTitle = document.getElementById("sidebar-title");
  const sidebarDesc = document.getElementById("sidebar-desc");

  const panelVoice = document.getElementById("panel-voice");
  const panelPhoto = document.getElementById("panel-photo");
  const panelResult = document.getElementById("panel-result");

  const voiceIconWrap = document.getElementById("voice-icon-wrap");
  const ivStatement = document.getElementById("iv-statement");
  const attestationText = document.getElementById("attestation-text");
  const ivWaveform = document.getElementById("iv-waveform");
  const waveformBars = [...ivWaveform.querySelectorAll(".iv-waveform__bar")];
  const recTimer = document.getElementById("rec-timer");
  const ctaIdle = document.getElementById("voice-cta-idle");
  const ctaRecording = document.getElementById("voice-cta-recording");
  const ctaReviewing = document.getElementById("voice-cta-reviewing");
  const btnStartRecording = document.getElementById("btn-start-recording");
  const btnStopRecording = document.getElementById("btn-stop-recording");
  const btnPlayback = document.getElementById("btn-playback");
  const playbackIcon = document.getElementById("playback-icon");
  const playbackLabel = document.getElementById("playback-label");
  const btnRetakeVoice = document.getElementById("btn-retake-voice");
  const btnContinueVoice = document.getElementById("btn-continue-voice");

  const refPhoto = document.getElementById("ref-photo");
  const refPhotoPlaceholder = document.getElementById("ref-photo-placeholder");
  const ivVideo = document.getElementById("iv-video");
  const ivCaptured = document.getElementById("iv-captured");
  const ivCanvas = document.getElementById("iv-canvas");
  const liveFrame = document.getElementById("live-frame");
  const liveBadge = document.getElementById("live-badge");
  const photoCaptureBtn = document.getElementById("photo-cta-capture");
  const photoConfirmCta = document.getElementById("photo-cta-confirm");
  const btnCapture = document.getElementById("btn-capture");
  const btnRetakePhoto = document.getElementById("btn-retake-photo");
  const btnSubmitPhoto = document.getElementById("btn-submit-photo");
  const btnBackToVoice = document.getElementById("btn-back-to-voice");

  const resultRef = document.getElementById("result-ref");
  const resultCaptured = document.getElementById("result-captured");
  const resultMatchBadge = document.getElementById("result-match-badge");
  const resultStatus = document.getElementById("result-status");
  const resultMsg = document.getElementById("result-msg");
  const btnBegin = document.getElementById("btn-begin-interview");
  const btnRetryPhoto = document.getElementById("btn-retry-photo");
  const resultTip = document.getElementById("result-tip");

  const stepPills = [1, 2, 3].map((n) => document.getElementById(`step-pill-${n}`));
  const stepLines = [1, 2].map((n) => document.getElementById(`step-line-${n}`));
  const stepDots = [1, 2, 3].map((n) => document.getElementById(`step-dot-${n}`));

  const SIDEBAR = {
    1: {
      titleKey: ["identity.sidebarVoiceTitle", "Voice Verification"],
      descKey: [
        "identity.sidebarVoiceDesc",
        "We need a short audio sample to verify your identity and ensure a secure session.",
      ],
    },
    2: {
      titleKey: ["identity.sidebarPhotoTitle", "Live Photo Match"],
      descKey: [
        "identity.sidebarPhotoDesc",
        "A quick live photo will be compared against your registered profile image.",
      ],
    },
    3: {
      titleKey: ["identity.sidebarResultTitle", "Verification Result"],
      descKey: [
        "identity.sidebarResultDesc",
        "Our system has processed your identity check. Almost there!",
      ],
    },
  };

  const ATTESTATION_FALLBACK =
    "I confirm that I am the person taking this interview, and I will follow the instructions.";

  // Register before the first await: i18n runs renderers once before revealing
  // the page, and a late registration paints untranslated text.
  window.i18n?.registerRenderer?.(renderI18n);

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  function renderI18n() {
    sidebarTitle.textContent = tr(...SIDEBAR[currentStep].titleKey);
    sidebarDesc.textContent = tr(...SIDEBAR[currentStep].descKey);
    renderAttestation();
    renderLiveBadge();
    renderPlaybackBtn();
    renderContinueVoiceButton();
    renderSubmitPhotoButton();
    renderBeginButton();
    renderResult();
    renderError();
  }

  // Once recorded, the statement stays pinned to the words actually spoken, so a
  // language switch can't show a different sentence than the one submitted.
  function renderAttestation() {
    attestationText.textContent = recordingMeta?.statementText
      ? recordingMeta.statementText
      : tr("attestation.statement", ATTESTATION_FALLBACK);
  }

  function renderLiveBadge() {
    liveBadge.textContent = capturedDataUrl
      ? tr("identity.photoCaptured", "PHOTO CAPTURED")
      : tr("identity.positionFace", "POSITION YOUR FACE");
  }

  function renderPlaybackBtn() {
    if (isPlaying) {
      playbackIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
      playbackLabel.textContent = tr("identity.pause", "Pause");
    } else {
      playbackIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
      playbackLabel.textContent = tr("identity.listenBack", "Listen back");
    }
  }

  function renderContinueVoiceButton() {
    btnContinueVoice.disabled = voiceSubmitting;
    btnRetakeVoice.disabled = voiceSubmitting;
    btnPlayback.disabled = voiceSubmitting;
    btnContinueVoice.innerHTML = voiceSubmitting
      ? `<span class="iv-spinner"></span>${tr("identity.submitting", "Submitting…")}`
      : tr("common.continue", "Continue");
    renderNavLock();
  }

  function renderSubmitPhotoButton() {
    btnSubmitPhoto.disabled = photoVerifying;
    btnRetakePhoto.disabled = photoVerifying;
    btnSubmitPhoto.innerHTML = photoVerifying
      ? `<span class="iv-spinner"></span>${tr("identity.verifyingIdentity", "Verifying Identity…")}`
      : tr("identity.confirmSubmit", "Confirm & Submit");
    renderNavLock();
  }

  function renderBeginButton() {
    btnBegin.disabled = beginLoading;
    btnBegin.innerHTML = beginLoading
      ? `<span class="iv-spinner"></span> ${tr("identity.loading", "Loading…")}`
      : tr("common.continue", "Continue");
    renderNavLock();
  }

  // Leaving mid-request would let the response land on a page that's gone.
  function renderNavLock() {
    const busy = voiceSubmitting || photoVerifying || beginLoading;
    topBack.disabled = busy;
    btnBackToVoice.disabled = busy;
  }

  function renderResult() {
    if (lastResultMatch === null) {
      return;
    }
    const variant = lastResultMatch ? "match" : "no-match";
    const matchLabel = lastResultMatch
      ? tr("identity.matched", "Matched")
      : tr("identity.noMatch", "No Match");

    // Rebuilding the badge would replay its animation on every language switch.
    if (resultMatchBadge.dataset.variant === variant) {
      resultMatchBadge.querySelector(".iv-result-match__pill").textContent = matchLabel;
    } else {
      const icon = lastResultMatch
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline pathLength="1" points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line pathLength="1" x1="18" y1="6" x2="6" y2="18"/><line pathLength="1" x1="6" y1="6" x2="18" y2="18"/></svg>`;
      resultMatchBadge.innerHTML = `
        <span class="iv-result-match__icon iv-result-match__icon--${variant}" aria-hidden="true">${icon}</span>
        <span class="iv-result-match__pill iv-result-match__pill--${variant}">${matchLabel}</span>`;
      resultMatchBadge.dataset.variant = variant;
    }

    if (lastResultMatch) {
      resultStatus.className = "iv-result-status iv-result-status--match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${checkSVG()}</div>
        <div>
          <p class="iv-result-status__heading">${tr("identity.identityVerified", "Identity Verified")}</p>
          <p class="iv-result-status__sub">${tr("identity.livenessSuccess", "Liveness check successful")}</p>
        </div>`;
      resultMsg.textContent = tr(
        "identity.verifiedMessage",
        "Your identity has been successfully confirmed. You are now cleared to enter the interview."
      );
    } else {
      resultStatus.className = "iv-result-status iv-result-status--no-match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${crossSVG()}</div>
        <div>
          <p class="iv-result-status__heading">${tr("identity.verificationFailed", "Verification Failed")}</p>
          <p class="iv-result-status__sub">${tr("identity.realignFace", "Please try re-aligning your face")}</p>
        </div>`;
      resultMsg.textContent = tr(
        "identity.noMatchMessage",
        "We couldn't match your live photo with our records. Ensure you are in a well-lit area and looking directly at the camera."
      );
    }
  }

  function renderError() {
    if (!lastError) {
      return;
    }
    errorText.textContent = tr(lastError.key, lastError.fallback, lastError.params);
    errorBanner.hidden = false;
  }

  function showError(key, fallback, params) {
    lastError = { key, fallback, params };
    renderError();
  }

  function showVoiceErrorForCode(code) {
    const [key, fallback] = VOICE_ERROR_KEYS[code] || VOICE_ERROR_KEYS.unknown;
    showError(key, fallback);
  }

  function showPhotoErrorForCode(code) {
    const [key, fallback] = PHOTO_ERROR_KEYS[code] || PHOTO_ERROR_KEYS.unknown;
    showError(key, fallback);
  }

  function hideError() {
    lastError = null;
    errorBanner.hidden = true;
  }

  function checkSVG() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }

  function crossSVG() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }

  function goToStep(n) {
    hideError();
    currentStep = n;

    panelVoice.hidden = n !== 1;
    panelPhoto.hidden = n !== 2;
    panelResult.hidden = n !== 3;

    stepPills.forEach((pill, i) => {
      const step = i + 1;
      pill.classList.remove("iv-step--active", "iv-step--done");
      if (step < n) {
        pill.classList.add("iv-step--done");
      } else if (step === n) {
        pill.classList.add("iv-step--active");
      }
    });

    stepDots.forEach((dot, i) => {
      const step = i + 1;
      if (step < n) {
        dot.innerHTML = checkSVG();
      } else {
        dot.textContent = new Intl.NumberFormat(window.i18n?.getLocale?.() || "en").format(step);
      }
    });

    stepLines.forEach((line, i) => {
      line.classList.toggle("iv-step__line--done", i + 1 < n);
    });

    if (n === 2 && !capturedDataUrl) {
      startCamera();
    }

    renderI18n();
  }

  async function resolveImageUrl(url) {
    // Proxied through main so CDN/S3 URLs aren't blocked by the renderer CSP.
    try {
      const res = await window.electronAPI?.fetchProfileImage?.(url);
      if (res?.ok && res.dataUrl) {
        return res.dataUrl;
      }
    } catch {
      /* fall through to the direct URL */
    }
    return url;
  }

  async function showRefPhoto(src) {
    const resolved = await resolveImageUrl(src);
    refPhoto.onload = () => {
      refPhoto.style.display = "block";
      refPhotoPlaceholder.style.display = "none";
    };
    refPhoto.onerror = () => {
      refPhoto.style.display = "none";
      refPhotoPlaceholder.style.display = "flex";
    };
    refPhoto.src = resolved;
  }

  async function loadProfile() {
    try {
      const result = await window.electronAPI?.getCandidateProfile?.();
      if (result?.success && result.data?.profile_photo) {
        profilePhotoSrc = result.data.profile_photo;
        await showRefPhoto(profilePhotoSrc);
      }
    } catch {
      /* non-fatal — placeholder stays */
    }
  }

  function getBestMime() {
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function formatDuration(ms) {
    const locale = window.i18n?.getLocale?.() || "en";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = new Intl.NumberFormat(locale).format(Math.floor(totalSeconds / 60));
    const seconds = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(
      totalSeconds % 60
    );
    return `${minutes}:${seconds}`;
  }

  function renderRecTimer(elapsed) {
    const shown = Math.min(elapsed, MAX_RECORDING_MS);
    recTimer.textContent = `${formatDuration(shown)} / ${formatDuration(MAX_RECORDING_MS)}`;
  }

  function startRecTimer() {
    recordingStartedAt = performance.now();
    btnStopRecording.disabled = true;
    renderRecTimer(0);
    recordingTimer = setInterval(() => {
      const elapsed = performance.now() - recordingStartedAt;
      renderRecTimer(elapsed);
      btnStopRecording.disabled = elapsed < MIN_RECORDING_MS;
      if (elapsed >= MAX_RECORDING_MS) {
        stopRecording();
      }
    }, 200);
  }

  function stopRecTimer() {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }

  // Drives the waveform from the live mic and records the loudest moment, so a
  // muted mic is caught before submit instead of by the backend.
  function startMeter(stream) {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const freq = new Uint8Array(analyser.frequencyBinCount);
      const wave = new Uint8Array(analyser.fftSize);
      const half = Math.ceil(waveformBars.length / 2);
      const binsPerBar = Math.max(1, Math.floor(analyser.frequencyBinCount / 3 / half));
      const m = { ctx, frame: 0, peak: 0 };

      const tick = () => {
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);

        let sumSquares = 0;
        for (const sample of wave) {
          const v = (sample - 128) / 128;
          sumSquares += v * v;
        }
        m.peak = Math.max(m.peak, Math.sqrt(sumSquares / wave.length));

        // Lowest bands in the middle, mirrored outwards.
        for (let i = 0; i < half; i++) {
          let energy = 0;
          for (let j = 0; j < binsPerBar; j++) {
            energy += freq[i * binsPerBar + j];
          }
          const scale = Math.max(0.12, Math.sqrt(energy / binsPerBar / 255));
          waveformBars[half - 1 - i].style.transform = `scaleY(${scale})`;
          waveformBars[waveformBars.length - half + i].style.transform = `scaleY(${scale})`;
        }
        m.frame = requestAnimationFrame(tick);
      };

      meter = m;
      tick();
    } catch {
      meter = null;
    }
  }

  function stopMeter() {
    if (!meter) {
      return;
    }
    cancelAnimationFrame(meter.frame);
    meter.ctx.close().catch(() => {});
    meter = null;
    waveformBars.forEach((bar) => bar.style.removeProperty("transform"));
  }

  function discardRecording(key, fallback, params) {
    audioBlob = null;
    recordingMeta = null;
    setVoiceState("idle");
    showError(key, fallback, params);
  }

  async function startRecording() {
    hideError();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = getBestMime();
      audioMimeType = mime;
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        const peak = meter?.peak;
        stopMeter();
        stopRecTimer();
        stream.getTracks().forEach((t) => t.stop());

        // The recorder's actual MIME, not our guess, so the blob type matches its data.
        const actualMime = mediaRecorder.mimeType || mime || "audio/webm";
        audioMimeType = actualMime;
        audioBlob = new Blob(audioChunks, { type: actualMime });

        const silent = peak !== undefined && peak < SILENCE_RMS;
        if (audioBlob.size === 0 || silent) {
          discardRecording(
            "identity.noAudioCaptured",
            "No audio was captured. Please check your microphone and record again."
          );
          return;
        }

        // The backend picks its STT/voice-match model from this, so it must describe
        // what was spoken into this blob even if the language changes later.
        recordingMeta = {
          locale: window.i18n?.getLocale?.(),
          statementText: attestationText?.textContent?.trim(),
        };

        if (audioURL) {
          URL.revokeObjectURL(audioURL);
        }
        audioURL = URL.createObjectURL(audioBlob);
        setVoiceState("reviewing");
      };

      // Without this a hardware failure can leave the UI stuck on "recording".
      mediaRecorder.onerror = (e) => {
        stopMeter();
        stopRecTimer();
        stream.getTracks().forEach((t) => t.stop());
        discardRecording(
          "identity.recordingInterrupted",
          "Recording was interrupted: {error}. Please try again.",
          {
            error:
              e.error?.message ||
              tr("identity.micAccessDenied", "Microphone access denied or hardware error."),
          }
        );
      };

      mediaRecorder.start();
      startMeter(stream);
      startRecTimer();
      setVoiceState("recording");
    } catch {
      showError("identity.micAccessDenied", "Microphone access denied or hardware error.");
    }
  }

  function stopRecording() {
    stopRecTimer();
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  function retakeVoice() {
    if (audioURL) {
      URL.revokeObjectURL(audioURL);
      audioURL = null;
    }
    audioBlob = null;
    recordingMeta = null;
    isPlaying = false;
    audioPlayer.pause();
    audioPlayer.src = "";
    setVoiceState("idle");
    renderAttestation();
    renderPlaybackBtn();
  }

  async function togglePlayback() {
    if (!audioURL) {
      return;
    }
    if (isPlaying) {
      audioPlayer.pause();
      isPlaying = false;
      renderPlaybackBtn();
      return;
    }
    audioPlayer.src = audioURL;
    audioPlayer.onended = () => {
      isPlaying = false;
      renderPlaybackBtn();
    };
    try {
      await audioPlayer.play();
      isPlaying = true;
    } catch (err) {
      isPlaying = false;
      showError("identity.audioPlaybackError", "Could not play back audio: {error}", {
        error: err.message,
      });
    }
    renderPlaybackBtn();
  }

  function setVoiceState(s) {
    ctaIdle.hidden = s !== "idle";
    ctaRecording.hidden = s !== "recording";
    ctaReviewing.hidden = s !== "reviewing";
    ivWaveform.hidden = s !== "recording";

    ivStatement.classList.toggle("iv-statement--recording", s === "recording");
    voiceIconWrap.classList.toggle("iv-voice__icon-wrap--recording", s === "recording");
  }

  async function submitVoice() {
    if (!audioBlob || audioBlob.size === 0) {
      showError("identity.recordVoiceFirst", "Please record a voice sample first.");
      return;
    }
    if (isPlaying) {
      audioPlayer.pause();
      isPlaying = false;
      renderPlaybackBtn();
    }
    voiceSubmitting = true;
    renderContinueVoiceButton();
    try {
      const buffer = await audioBlob.arrayBuffer();
      const meta = recordingMeta || {
        locale: window.i18n?.getLocale?.(),
        statementText: attestationText?.textContent?.trim(),
      };
      const result = await window.electronAPI?.submitVoiceSample?.(
        new Uint8Array(buffer),
        audioMimeType,
        meta
      );
      if (result?.ok) {
        voiceSubmitting = false;
        goToStep(2);
      } else {
        showVoiceErrorForCode(result?.code);
        voiceSubmitting = false;
        renderContinueVoiceButton();
      }
    } catch {
      showError("identity.networkError", "Network error. Please try again.");
      voiceSubmitting = false;
      renderContinueVoiceButton();
    }
  }

  function setCameraState(s) {
    liveFrame.classList.toggle("iv-photo-frame--starting", s === "starting");
    liveFrame.classList.toggle("iv-photo-frame--unavailable", s === "unavailable");
  }

  async function startCamera() {
    setCameraState("starting");
    btnCapture.disabled = true;
    ivVideo.hidden = false;
    ivCaptured.hidden = true;
    photoCaptureBtn.hidden = false;
    photoConfirmCta.hidden = true;
    liveFrame.classList.remove("iv-photo-frame--captured");
    liveBadge.className = "iv-photo-frame__badge iv-photo-frame__badge--live";
    renderLiveBadge();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
      });
      // The candidate may have gone back to the voice step while this was pending.
      if (currentStep !== 2 || capturedDataUrl) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      videoStream = stream;
      ivVideo.addEventListener(
        "loadeddata",
        () => {
          setCameraState("live");
          btnCapture.disabled = false;
        },
        { once: true }
      );
      ivVideo.srcObject = stream;
    } catch {
      setCameraState("unavailable");
      showError("identity.cameraAccessDenied", "Camera access denied.");
    }
  }

  function stopCamera() {
    videoStream?.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }

  function capturePhoto() {
    if (!ivVideo.videoWidth) {
      return;
    }
    ivCanvas.width = ivVideo.videoWidth;
    ivCanvas.height = ivVideo.videoHeight;
    const ctx = ivCanvas.getContext("2d");
    // Mirrored to match the mirrored preview.
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(ivVideo, -ivCanvas.width, 0, ivCanvas.width, ivCanvas.height);
    ctx.restore();

    capturedDataUrl = ivCanvas.toDataURL("image/jpeg", 0.85);
    ivCaptured.src = capturedDataUrl;
    ivCaptured.hidden = false;
    ivVideo.hidden = true;

    stopCamera();

    liveFrame.classList.add("iv-photo-frame--captured");
    liveBadge.classList.remove("iv-photo-frame__badge--live");
    liveBadge.classList.add("iv-photo-frame__badge--captured");
    renderLiveBadge();

    photoCaptureBtn.hidden = true;
    photoConfirmCta.hidden = false;
  }

  function retakePhoto() {
    capturedDataUrl = null;
    startCamera();
  }

  async function submitPhoto() {
    if (!capturedDataUrl) {
      return;
    }
    photoVerifying = true;
    renderSubmitPhotoButton();
    try {
      const result = await window.electronAPI?.submitFaceVerification?.(capturedDataUrl);
      if (result?.ok) {
        await showResult(result.data);
      } else {
        showPhotoErrorForCode(result?.code);
        photoVerifying = false;
        renderSubmitPhotoButton();
      }
    } catch {
      showError("identity.networkError", "Network error. Please try again.");
      photoVerifying = false;
      renderSubmitPhotoButton();
    }
  }

  async function showResult(data) {
    lastResultMatch = !!data?.match;

    if (profilePhotoSrc) {
      resultRef.src = await resolveImageUrl(profilePhotoSrc);
    }
    resultCaptured.src = capturedDataUrl;

    btnBegin.hidden = !lastResultMatch;
    btnRetryPhoto.hidden = lastResultMatch;
    resultTip.hidden = lastResultMatch;

    photoVerifying = false;
    goToStep(3);
  }

  btnStartRecording.addEventListener("click", startRecording);
  btnStopRecording.addEventListener("click", stopRecording);
  btnPlayback.addEventListener("click", togglePlayback);
  btnRetakeVoice.addEventListener("click", retakeVoice);
  btnContinueVoice.addEventListener("click", submitVoice);

  btnCapture.addEventListener("click", capturePhoto);
  btnRetakePhoto.addEventListener("click", retakePhoto);
  btnSubmitPhoto.addEventListener("click", submitPhoto);
  btnBackToVoice.addEventListener("click", () => {
    stopCamera();
    capturedDataUrl = null;
    goToStep(1);
  });

  btnBegin.addEventListener("click", async () => {
    if (btnBegin.disabled) {
      return;
    }
    if (typeof window.electronAPI?.loadRoleSelection !== "function") {
      showError("identity.startUnavailable", "Unable to continue. Please restart the app.");
      return;
    }
    beginLoading = true;
    renderBeginButton();
    // Main injects this photo into the interview window's sessionStorage. The
    // interview's identity checks compare against it, so none without it.
    let stored = false;
    try {
      stored = (await window.electronAPI?.storeCandidatePhoto?.(capturedDataUrl)) === true;
    } catch {
      stored = false;
    }
    if (!stored) {
      beginLoading = false;
      renderBeginButton();
      showError("identity.photoStoreFailed", "We couldn't save your photo. Please try again.");
      return;
    }
    window.electronAPI.loadRoleSelection();
    // Navigation tears this page down; if we're still here, let the user retry.
    window.armButtonRestore(btnBegin, "", {
      onRestore: () => {
        beginLoading = false;
        renderBeginButton();
        showError("identity.startTimedOut", "That took too long. Please try again.");
      },
    });
  });

  btnRetryPhoto.addEventListener("click", () => {
    capturedDataUrl = null;
    goToStep(2);
  });

  window.addEventListener("beforeunload", () => {
    stopCamera();
    stopMeter();
    stopRecTimer();
    audioPlayer.pause();
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  });

  // Not awaited: a slow profile fetch must not hold up or reset the first step.
  goToStep(1);
  loadProfile();
});
