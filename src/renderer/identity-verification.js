"use strict";

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
}

document.addEventListener("DOMContentLoaded", async () => {
  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

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

  const errorBanner = document.getElementById("iv-error");
  const errorText = document.getElementById("iv-error-text");

  const sidebarTitle = document.getElementById("sidebar-title");
  const sidebarDesc = document.getElementById("sidebar-desc");

  const panelVoice = document.getElementById("panel-voice");
  const panelPhoto = document.getElementById("panel-photo");
  const panelResult = document.getElementById("panel-result");

  const voiceIconWrap = document.getElementById("voice-icon-wrap");
  const ivStatement = document.getElementById("iv-statement");
  const ivWaveform = document.getElementById("iv-waveform");
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
      descKey: ["identity.sidebarResultDesc", "Our system has processed your identity check. Almost there!"],
    },
  };

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() {
    errorBanner.hidden = true;
  }

  function setLoading(btn, loading, labelText) {
    if (loading) {
      btn.disabled = true;
      btn.innerHTML = `<span class="iv-spinner"></span>${labelText}`;
    } else {
      btn.disabled = false;
    }
  }

  function checkSVG() {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }

  function crossSVG(color) {
    return `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  }

  function checkLgSVG(color) {
    return `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }

  function goToStep(n) {
    hideError();

    panelVoice.hidden = n !== 1;
    panelPhoto.hidden = n !== 2;
    panelResult.hidden = n !== 3;

    sidebarTitle.textContent = tr(...SIDEBAR[n].titleKey);
    sidebarDesc.textContent = tr(...SIDEBAR[n].descKey);

    stepPills.forEach((pill, i) => {
      const step = i + 1;
      pill.classList.remove("iv-step--active", "iv-step--done");
      if (step < n) {
        pill.classList.add("iv-step--done");
      } else if (step === n) {
        pill.classList.add("iv-step--active");
      }
    });

    // Dot content: done = checkmark
    stepDots.forEach((dot, i) => {
      const step = i + 1;
      if (step < n) {
        dot.innerHTML = checkSVG().replace('width="20" height="20"', 'width="13" height="13"');
      } else {
        dot.textContent = step;
      }
    });

    stepLines.forEach((line, i) => {
      const prevStep = i + 1;
      line.classList.toggle("iv-step--done", prevStep < n);
      line.style.background = prevStep < n ? "#16a34a" : "";
    });

    if (n === 2 && !capturedDataUrl) {
      startCamera();
    }

    // Entering the voice step from any path — ensure the Continue button is not
    // left in a stale disabled/spinner state (e.g. after a submit + back nav).
    if (n === 1) {
      btnContinueVoice.disabled = false;
      btnContinueVoice.innerHTML = `${tr("common.continue", "Continue")} ${CONTINUE_ICON_SVG}`;
    }
  }

  const CONTINUE_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
  function resetContinueVoiceButton() {
    btnContinueVoice.disabled = false;
    btnContinueVoice.innerHTML = `${tr("identity.continueToStep2", "Continue to Step 2")} ${CONTINUE_ICON_SVG}`;
  }
  const CONFIRM_SUBMIT_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><polyline points="16 3 12 7 8 3"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  function resetSubmitPhotoButton() {
    btnSubmitPhoto.disabled = false;
    btnSubmitPhoto.innerHTML = `${CONFIRM_SUBMIT_ICON_SVG} ${tr("identity.confirmSubmit", "Confirm & Submit")}`;
  }

  // ── Load profile photo
  const refPhotoPlaceholder = document.getElementById("ref-photo-placeholder");

  async function resolveImageUrl(url) {
    // Proxy through main process so CDN/S3 URLs aren't blocked by renderer CSP
    try {
      const res = await window.electronAPI?.fetchProfileImage?.(url);
      if (res?.ok && res.dataUrl) {
        return res.dataUrl;
      }
    } catch {
      /* fall through */
    }
    return url; // fallback: try direct (may fail under strict CSP)
  }

  async function showRefPhoto(src) {
    const resolved = await resolveImageUrl(src);
    refPhoto.onload = () => {
      refPhoto.style.display = "block";
      if (refPhotoPlaceholder) {
        refPhotoPlaceholder.style.display = "none";
      }
    };
    refPhoto.onerror = () => {
      refPhoto.style.display = "none";
      if (refPhotoPlaceholder) {
        refPhotoPlaceholder.style.display = "flex";
      }
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

  // ── Audio recorder

  function getBestMime() {
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
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
        // Use the MIME type the browser actually chose (not our guess) so the
        // blob type always matches the recorded data format.
        const actualMime = mediaRecorder.mimeType || mime || "audio/webm";
        audioMimeType = actualMime;
        audioBlob = new Blob(audioChunks, { type: actualMime });
        stream.getTracks().forEach((t) => t.stop());

        console.log(
          "[audio] actualMime:",
          actualMime,
          "chunks:",
          audioChunks.length,
          "blobSize:",
          audioBlob.size
        );

        // A mid-recording failure (device unplug, OS revoke) can leave zero bytes —
        // don't advance to review with an empty sample that fails silently at submit.
        if (!audioBlob || audioBlob.size === 0) {
          audioBlob = null;
          setVoiceState("idle");
          showError(
            tr("identity.noAudioCaptured", "No audio was captured. Please check your microphone and record again.")
          );
          return;
        }

        if (audioURL) {
          URL.revokeObjectURL(audioURL);
        }
        audioURL = URL.createObjectURL(audioBlob);
        setVoiceState("reviewing");
      };

      // Without this, a mid-recording hardware failure gets swallowed — onstop
      // may never fire and the UI stays stuck on "recording".
      mediaRecorder.onerror = (e) => {
        stream.getTracks().forEach((t) => t.stop());
        audioBlob = null;
        setVoiceState("idle");
        showError(
          tr("identity.recordingInterrupted", "Recording was interrupted: {error}. Please try again.", {
            error: e.error?.message || "microphone error",
          })
        );
      };

      mediaRecorder.start();
      setVoiceState("recording");
    } catch {
      showError(tr("identity.micAccessDenied", "Microphone access denied or hardware error."));
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  function retakeVoice() {
    if (audioURL) {
      URL.revokeObjectURL(audioURL);
      audioURL = null;
    }
    audioBlob = null;
    isPlaying = false;
    audioPlayer.pause();
    audioPlayer.src = "";
    setVoiceState("idle");
  }

  async function togglePlayback() {
    if (!audioURL) {
      return;
    }
    if (isPlaying) {
      audioPlayer.pause();
      isPlaying = false;
      updatePlaybackBtn();
      return;
    }
    audioPlayer.src = audioURL;
    audioPlayer.onended = () => {
      isPlaying = false;
      updatePlaybackBtn();
    };
    try {
      await audioPlayer.play();
      isPlaying = true;
    } catch (err) {
      isPlaying = false;
      showError(tr("identity.audioPlaybackError", "Could not play back audio: {error}", { error: err.message }));
    }
    updatePlaybackBtn();
  }

  function updatePlaybackBtn() {
    if (isPlaying) {
      playbackIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
      playbackLabel.textContent = tr("identity.pause", "Pause");
    } else {
      playbackIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
      playbackLabel.textContent = tr("identity.listenBack", "Listen back");
    }
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
      showError(tr("identity.recordVoiceFirst", "Please record a voice sample first."));
      return;
    }
    setLoading(btnContinueVoice, true, tr("identity.submitting", "Submitting…"));
    try {
      const buffer = await audioBlob.arrayBuffer();
      // Send the active locale + the exact attestation text the candidate read
      // aloud, so backend STT/voice-match uses the right language model.
      const statementText = document.getElementById("attestation-text")?.textContent?.trim();
      const meta = { locale: window.i18n?.getLocale?.(), statementText };
      const result = await window.electronAPI?.submitVoiceSample?.(
        new Uint8Array(buffer),
        audioMimeType,
        meta
      );
      if (result?.ok) {
        goToStep(2);
      } else {
        showError(result?.error || tr("identity.voiceSubmitFailed", "Voice submission failed. Please try again."));
        resetContinueVoiceButton();
      }
    } catch {
      showError(tr("identity.networkError", "Network error. Please try again."));
      resetContinueVoiceButton();
    }
  }

  async function startCamera() {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } },
      });
      ivVideo.srcObject = videoStream;
      ivVideo.hidden = false;
      ivCaptured.hidden = true;
      photoCaptureBtn.hidden = false;
      photoConfirmCta.hidden = true;
      liveBadge.textContent = tr("identity.positionFace", "POSITION YOUR FACE");
      liveBadge.className = "iv-photo-frame__badge iv-photo-frame__badge--live";
      liveFrame.classList.remove("iv-photo-frame--captured");
    } catch {
      showError(tr("identity.cameraAccessDenied", "Camera access denied."));
    }
  }

  function stopCamera() {
    videoStream?.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }

  function capturePhoto() {
    ivCanvas.width = ivVideo.videoWidth || 640;
    ivCanvas.height = ivVideo.videoHeight || 640;
    const ctx = ivCanvas.getContext("2d");
    // Mirror horizontally to match the mirrored video display
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
    liveBadge.textContent = tr("identity.photoCaptured", "PHOTO CAPTURED");
    liveBadge.classList.remove("iv-photo-frame__badge--live");
    liveBadge.classList.add("iv-photo-frame__badge--captured");

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
    setLoading(btnSubmitPhoto, true, tr("identity.verifyingIdentity", "Verifying Identity…"));
    btnRetakePhoto.disabled = true;
    try {
      const result = await window.electronAPI?.submitFaceVerification?.(capturedDataUrl);
      if (result?.ok) {
        await showResult(result.data);
      } else {
        showError(result?.error || tr("identity.faceVerificationFailed", "Face verification failed. Please try again."));
        resetSubmitPhotoButton();
        btnRetakePhoto.disabled = false;
      }
    } catch {
      showError(tr("identity.networkError", "Network error. Please try again."));
      resetSubmitPhotoButton();
      btnRetakePhoto.disabled = false;
    }
  }

  async function showResult(data) {
    const isMatch = !!data?.match;

    // Fill comparison images — proxy registered photo through main to avoid CSP
    if (profilePhotoSrc) {
      resultRef.src = await resolveImageUrl(profilePhotoSrc);
    }
    resultCaptured.src = capturedDataUrl; // already a local data: URL — no proxy needed

    const matchLabel = isMatch ? tr("identity.matched", "Matched") : tr("identity.noMatch", "No Match");
    resultMatchBadge.innerHTML = `<span class="iv-result-match__pill ${isMatch ? "iv-result-match__pill--match" : "iv-result-match__pill--no-match"}">${matchLabel}</span>`;

    if (isMatch) {
      resultStatus.className = "iv-result-status iv-result-status--match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${checkLgSVG("#16a34a")}</div>
        <div>
          <p class="iv-result-status__heading" style="color:#14532d">${tr("identity.identityVerified", "Identity Verified")}</p>
          <p class="iv-result-status__sub">${tr("identity.livenessSuccess", "Liveness check successful")}</p>
        </div>`;
      resultMsg.textContent = tr(
        "identity.verifiedMessage",
        "Your identity has been successfully confirmed. You are now cleared to enter the interview."
      );
      btnBegin.hidden = false;
      btnRetryPhoto.hidden = true;
      resultTip.hidden = true;
    } else {
      resultStatus.className = "iv-result-status iv-result-status--no-match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${crossSVG("#dc2626")}</div>
        <div>
          <p class="iv-result-status__heading" style="color:#7f1d1d">${tr("identity.verificationFailed", "Verification Failed")}</p>
          <p class="iv-result-status__sub">${tr("identity.realignFace", "Please try re-aligning your face")}</p>
        </div>`;
      resultMsg.textContent = tr(
        "identity.noMatchMessage",
        "We couldn't match your live photo with our records. Ensure you are in a well-lit area and looking directly at the camera."
      );
      btnBegin.hidden = true;
      btnRetryPhoto.hidden = false;
      resultTip.hidden = false;
    }

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
    // Restore voice continue button — may have been left in spinner state after a successful submit
    resetContinueVoiceButton();
    goToStep(1);
  });

  const beginBtnHTML = btnBegin.innerHTML; // capture original for restore
  btnBegin.addEventListener("click", async () => {
    if (btnBegin.disabled) {
      return;
    }
    // Fail loud if the bridge method is missing — never spin forever silently.
    if (typeof window.electronAPI?.loadRoleSelection !== "function") {
      showError(tr("identity.startUnavailable", "Unable to continue. Please restart the app."));
      return;
    }
    btnBegin.disabled = true;
    btnBegin.innerHTML = `<span class="iv-spinner"></span> ${tr("identity.loading", "Loading…")}`;
    // Hand the verified live photo to the main process so it can inject it into
    // sessionStorage on the interview window before the React SPA boots.
    try {
      await window.electronAPI?.storeCandidatePhoto?.(capturedDataUrl);
    } catch {
      /* non-fatal — proceed to role selection regardless */
    }
    window.electronAPI.loadRoleSelection();
    // Watchdog: successful navigation tears down this page. If this fires,
    // navigation never happened — restore the button so the user can retry.
    window.armButtonRestore(btnBegin, beginBtnHTML, {
      onRestore: () => showError(tr("identity.startTimedOut", "That took too long. Please try again.")),
    });
  });

  btnRetryPhoto.addEventListener("click", () => {
    capturedDataUrl = null;
    // Restore photo buttons — may have been left in spinner/disabled state after a successful submit
    resetSubmitPhotoButton();
    btnRetakePhoto.disabled = false;
    goToStep(2);
  });

  // ── Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    stopCamera();
    audioPlayer.pause();
    if (mediaRecorder?.state !== "inactive") {
      mediaRecorder?.stop();
    }
  });

  // Don't await loadProfile() — a slow fetch resolving after the user moves on
  // would snap them back to step 1. Fire and forget; the photo binds on onload.
  goToStep(1);
  loadProfile();
});
