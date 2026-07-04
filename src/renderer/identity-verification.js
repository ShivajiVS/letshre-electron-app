"use strict";

document.addEventListener("DOMContentLoaded", async () => {

  // ── State ─────────────────────────────────────────────────────────────────
  let currentStep = 1;        // 1 | 2 | 3
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

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const errorBanner  = document.getElementById("iv-error");
  const errorText    = document.getElementById("iv-error-text");

  // Sidebar
  const sidebarTitle = document.getElementById("sidebar-title");
  const sidebarDesc  = document.getElementById("sidebar-desc");

  // Panels
  const panelVoice  = document.getElementById("panel-voice");
  const panelPhoto  = document.getElementById("panel-photo");
  const panelResult = document.getElementById("panel-result");

  // Voice
  const voiceIconWrap     = document.getElementById("voice-icon-wrap");
  const ivStatement       = document.getElementById("iv-statement");
  const ivWaveform        = document.getElementById("iv-waveform");
  const ctaIdle           = document.getElementById("voice-cta-idle");
  const ctaRecording      = document.getElementById("voice-cta-recording");
  const ctaReviewing      = document.getElementById("voice-cta-reviewing");
  const btnStartRecording = document.getElementById("btn-start-recording");
  const btnStopRecording  = document.getElementById("btn-stop-recording");
  const btnPlayback       = document.getElementById("btn-playback");
  const playbackIcon      = document.getElementById("playback-icon");
  const playbackLabel     = document.getElementById("playback-label");
  const btnRetakeVoice    = document.getElementById("btn-retake-voice");
  const btnContinueVoice  = document.getElementById("btn-continue-voice");

  // Photo
  const refPhoto        = document.getElementById("ref-photo");
  const ivVideo         = document.getElementById("iv-video");
  const ivCaptured      = document.getElementById("iv-captured");
  const ivCanvas        = document.getElementById("iv-canvas");
  const liveFrame       = document.getElementById("live-frame");
  const liveBadge       = document.getElementById("live-badge");
  const photoCaptureBtn = document.getElementById("photo-cta-capture");
  const photoConfirmCta = document.getElementById("photo-cta-confirm");
  const btnCapture      = document.getElementById("btn-capture");
  const btnRetakePhoto  = document.getElementById("btn-retake-photo");
  const btnSubmitPhoto  = document.getElementById("btn-submit-photo");
  const btnBackToVoice  = document.getElementById("btn-back-to-voice");

  // Result
  const resultRef        = document.getElementById("result-ref");
  const resultCaptured   = document.getElementById("result-captured");
  const resultMatchBadge = document.getElementById("result-match-badge");
  const resultStatus     = document.getElementById("result-status");
  const resultMsg        = document.getElementById("result-msg");
  const btnBegin         = document.getElementById("btn-begin-interview");
  const btnRetryPhoto    = document.getElementById("btn-retry-photo");
  const resultTip        = document.getElementById("result-tip");

  // Step pills
  const stepPills = [1, 2, 3].map(n => document.getElementById(`step-pill-${n}`));
  const stepLines = [1, 2].map(n => document.getElementById(`step-line-${n}`));
  const stepDots  = [1, 2, 3].map(n => document.getElementById(`step-dot-${n}`));

  // ── Sidebar content per step ──────────────────────────────────────────────
  const SIDEBAR = {
    1: { title: "Voice Verification", desc: "We need a short audio sample to verify your identity and ensure a secure session." },
    2: { title: "Live Photo Match",   desc: "A quick live photo will be compared against your registered profile image." },
    3: { title: "Verification Result", desc: "Our system has processed your identity check. Almost there!" },
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.hidden = false;
  }

  function hideError() { errorBanner.hidden = true; }

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

  // ── Step navigation ───────────────────────────────────────────────────────

  function goToStep(n) {
    currentStep = n;
    hideError();

    // Panels
    panelVoice.hidden  = n !== 1;
    panelPhoto.hidden  = n !== 2;
    panelResult.hidden = n !== 3;

    // Sidebar
    sidebarTitle.textContent = SIDEBAR[n].title;
    sidebarDesc.textContent  = SIDEBAR[n].desc;

    // Sub-step pills
    stepPills.forEach((pill, i) => {
      const step = i + 1;
      pill.classList.remove("iv-step--active", "iv-step--done");
      if (step < n) pill.classList.add("iv-step--done");
      else if (step === n) pill.classList.add("iv-step--active");
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

    // Connector lines
    stepLines.forEach((line, i) => {
      const prevStep = i + 1;
      line.classList.toggle("iv-step--done", prevStep < n);
      line.style.background = prevStep < n ? "#16a34a" : "";
    });

    // If entering photo step, start camera
    if (n === 2 && !capturedDataUrl) {
      startCamera();
    }

    // Entering the voice step from any path — ensure the Continue button is not
    // left in a stale disabled/spinner state (e.g. after a submit + back nav).
    if (n === 1) {
      btnContinueVoice.disabled = false;
      btnContinueVoice.innerHTML = `Continue <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
    }
  }

  // ── Load profile photo ────────────────────────────────────────────────────

  const refPhotoPlaceholder = document.getElementById("ref-photo-placeholder");

  async function resolveImageUrl(url) {
    // Proxy through main process so CDN/S3 URLs aren't blocked by renderer CSP
    try {
      const res = await window.electronAPI?.fetchProfileImage?.(url);
      if (res?.ok && res.dataUrl) return res.dataUrl;
    } catch { /* fall through */ }
    return url; // fallback: try direct (may fail under strict CSP)
  }

  async function showRefPhoto(src) {
    const resolved = await resolveImageUrl(src);
    refPhoto.onload = () => {
      refPhoto.style.display = "block";
      if (refPhotoPlaceholder) refPhotoPlaceholder.style.display = "none";
    };
    refPhoto.onerror = () => {
      refPhoto.style.display = "none";
      if (refPhotoPlaceholder) refPhotoPlaceholder.style.display = "flex";
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
    } catch { /* non-fatal — placeholder stays */ }
  }

  // ── Audio recorder ────────────────────────────────────────────────────────

  function getBestMime() {
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
  }

  async function startRecording() {
    hideError();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = getBestMime();
      audioMimeType = mime;
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});

      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        // Use the MIME type the browser actually chose (not our guess) so the
        // blob type always matches the recorded data format.
        const actualMime = mediaRecorder.mimeType || mime || "audio/webm";
        audioMimeType = actualMime;
        audioBlob = new Blob(audioChunks, { type: actualMime });
        stream.getTracks().forEach(t => t.stop());

        console.log("[audio] actualMime:", actualMime, "chunks:", audioChunks.length, "blobSize:", audioBlob.size);

        if (audioURL) URL.revokeObjectURL(audioURL);
        audioURL = URL.createObjectURL(audioBlob);
        setVoiceState("reviewing");
      };

      mediaRecorder.start();
      setVoiceState("recording");
    } catch {
      showError("Microphone access denied or hardware error.");
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  }

  function retakeVoice() {
    if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
    audioBlob = null;
    isPlaying = false;
    audioPlayer.pause();
    audioPlayer.src = "";
    setVoiceState("idle");
  }

  async function togglePlayback() {
    if (!audioURL) return;
    if (isPlaying) {
      audioPlayer.pause();
      isPlaying = false;
      updatePlaybackBtn();
      return;
    }
    audioPlayer.src = audioURL;
    audioPlayer.onended = () => { isPlaying = false; updatePlaybackBtn(); };
    try {
      await audioPlayer.play();
      isPlaying = true;
    } catch (err) {
      isPlaying = false;
      showError("Could not play back audio: " + err.message);
    }
    updatePlaybackBtn();
  }

  function updatePlaybackBtn() {
    if (isPlaying) {
      playbackIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
      playbackLabel.textContent = "Pause";
    } else {
      playbackIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
      playbackLabel.textContent = "Listen back";
    }
  }

  function setVoiceState(s) {
    ctaIdle.hidden      = s !== "idle";
    ctaRecording.hidden = s !== "recording";
    ctaReviewing.hidden = s !== "reviewing";
    ivWaveform.hidden   = s !== "recording";

    ivStatement.classList.toggle("iv-statement--recording", s === "recording");
    voiceIconWrap.classList.toggle("iv-voice__icon-wrap--recording", s === "recording");
  }

  // ── Voice submit ──────────────────────────────────────────────────────────

  async function submitVoice() {
    if (!audioBlob) { showError("Please record a voice sample first."); return; }
    setLoading(btnContinueVoice, true, "Submitting…");
    try {
      const buffer = await audioBlob.arrayBuffer();
      const result = await window.electronAPI?.submitVoiceSample?.(new Uint8Array(buffer), audioMimeType);
      if (result?.ok) {
        goToStep(2);
      } else {
        showError(result?.error || "Voice submission failed. Please try again.");
        btnContinueVoice.disabled = false;
        btnContinueVoice.innerHTML = `Continue to Step 2 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
      }
    } catch (err) {
      showError("Network error. Please try again.");
      btnContinueVoice.disabled = false;
      btnContinueVoice.innerHTML = `Continue to Step 2 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
    }
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  async function startCamera() {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } } });
      ivVideo.srcObject = videoStream;
      ivVideo.hidden = false;
      ivCaptured.hidden = true;
      photoCaptureBtn.hidden = false;
      photoConfirmCta.hidden = true;
      liveBadge.textContent = "POSITION YOUR FACE";
      liveBadge.className = "iv-photo-frame__badge iv-photo-frame__badge--live";
      liveFrame.classList.remove("iv-photo-frame--captured");
    } catch {
      showError("Camera access denied.");
    }
  }

  function stopCamera() {
    videoStream?.getTracks().forEach(t => t.stop());
    videoStream = null;
  }

  function capturePhoto() {
    ivCanvas.width  = ivVideo.videoWidth  || 640;
    ivCanvas.height = ivVideo.videoHeight || 640;
    const ctx = ivCanvas.getContext("2d");
    // Mirror horizontally to match the mirrored video display
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(ivVideo, -ivCanvas.width, 0, ivCanvas.width, ivCanvas.height);
    ctx.restore();

    capturedDataUrl = ivCanvas.toDataURL("image/jpeg", 0.85);
    ivCaptured.src  = capturedDataUrl;
    ivCaptured.hidden = false;
    ivVideo.hidden    = true;

    stopCamera();

    liveFrame.classList.add("iv-photo-frame--captured");
    liveBadge.textContent = "PHOTO CAPTURED";
    liveBadge.classList.remove("iv-photo-frame__badge--live");
    liveBadge.classList.add("iv-photo-frame__badge--captured");

    photoCaptureBtn.hidden  = true;
    photoConfirmCta.hidden  = false;
  }

  function retakePhoto() {
    capturedDataUrl = null;
    startCamera();
  }

  // ── Face submit ───────────────────────────────────────────────────────────

  async function submitPhoto() {
    if (!capturedDataUrl) return;
    setLoading(btnSubmitPhoto, true, "Verifying Identity…");
    btnRetakePhoto.disabled = true;
    try {
      const result = await window.electronAPI?.submitFaceVerification?.(capturedDataUrl);
      if (result?.ok) {
        await showResult(result.data);
      } else {
        showError(result?.error || "Face verification failed. Please try again.");
        btnSubmitPhoto.disabled = false;
        btnSubmitPhoto.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><polyline points="16 3 12 7 8 3"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Confirm &amp; Submit`;
        btnRetakePhoto.disabled = false;
      }
    } catch {
      showError("Network error. Please try again.");
      btnSubmitPhoto.disabled = false;
      btnRetakePhoto.disabled = false;
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────

  async function showResult(data) {
    const isMatch = !!data?.match;

    // Fill comparison images — proxy registered photo through main to avoid CSP
    if (profilePhotoSrc) {
      resultRef.src = await resolveImageUrl(profilePhotoSrc);
    }
    resultCaptured.src = capturedDataUrl; // already a local data: URL — no proxy needed

    // Match badge
    resultMatchBadge.innerHTML = `<span class="iv-result-match__pill ${isMatch ? "iv-result-match__pill--match" : "iv-result-match__pill--no-match"}">${isMatch ? "Matched" : "No Match"}</span>`;

    // Status card
    if (isMatch) {
      resultStatus.className = "iv-result-status iv-result-status--match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${checkLgSVG("#16a34a")}</div>
        <div>
          <p class="iv-result-status__heading" style="color:#14532d">Identity Verified</p>
          <p class="iv-result-status__sub">Liveness check successful</p>
        </div>`;
      resultMsg.textContent = "Your identity has been successfully confirmed. You are now cleared to enter the interview.";
      btnBegin.hidden    = false;
      btnRetryPhoto.hidden = true;
      resultTip.hidden   = true;
    } else {
      resultStatus.className = "iv-result-status iv-result-status--no-match";
      resultStatus.innerHTML = `
        <div class="iv-result-status__icon">${crossSVG("#dc2626")}</div>
        <div>
          <p class="iv-result-status__heading" style="color:#7f1d1d">Verification Failed</p>
          <p class="iv-result-status__sub">Please try re-aligning your face</p>
        </div>`;
      resultMsg.textContent = "We couldn't match your live photo with our records. Ensure you are in a well-lit area and looking directly at the camera.";
      btnBegin.hidden     = true;
      btnRetryPhoto.hidden = false;
      resultTip.hidden    = false;
    }

    goToStep(3);
  }

  // ── Wire buttons ──────────────────────────────────────────────────────────

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
    btnContinueVoice.disabled = false;
    btnContinueVoice.innerHTML = `Continue to Step 2 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`;
    goToStep(1);
  });

  btnBegin.addEventListener("click", async () => {
    btnBegin.disabled = true;
    btnBegin.innerHTML = `<span class="iv-spinner"></span> Loading…`;
    // Hand the verified live photo to the main process so it can inject it into
    // sessionStorage on the interview window before the React SPA boots.
    await window.electronAPI?.storeCandidatePhoto?.(capturedDataUrl);
    window.electronAPI?.loadRoleSelection?.();
  });

  btnRetryPhoto.addEventListener("click", () => {
    capturedDataUrl = null;
    // Restore photo buttons — may have been left in spinner/disabled state after a successful submit
    btnSubmitPhoto.disabled = false;
    btnSubmitPhoto.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><polyline points="16 3 12 7 8 3"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Confirm &amp; Submit`;
    btnRetakePhoto.disabled = false;
    goToStep(2);
  });

  // ── Cleanup on page unload ────────────────────────────────────────────────

  window.addEventListener("beforeunload", () => {
    stopCamera();
    audioPlayer.pause();
    if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  // Navigate to step 1 immediately. loadProfile() is an async IPC round-trip;
  // awaiting it here caused a race where a slow profile fetch resolved AFTER the
  // user had already advanced to step 2, snapping them back to step 1 with the
  // Continue button stuck in its "Submitting…" state. Fire it and forget — the
  // profile image binds to the DOM via onload whenever it arrives.
  goToStep(1);
  loadProfile();
});
