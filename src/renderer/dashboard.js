/**
 * src/renderer/dashboard.js
 * ─────────────────────────
 * Dashboard controller. Fetches the candidate profile (name, photo, interview
 * attempts) from main via IPC — tokens never touch the renderer. Gates the
 * "Take interview" button on remaining attempts.
 */

"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  // Ensure the i18n bundle is loaded before we build any dynamic strings
  // below (window.t exists immediately, but reads against an empty bundle
  // until this resolves).
  if (window.i18n?.ready) { await window.i18n.ready; }

  const welcomeEl       = document.getElementById("welcome");
  const takeBtn         = document.getElementById("take-interview-btn");
  const logoutBtn       = document.getElementById("logout-btn");
  const dashNote        = document.getElementById("dash-note");

  // Profile card
  const profileAvatar   = document.getElementById("profile-avatar");
  const profileInitials = document.getElementById("profile-initials");
  const profileName     = document.getElementById("profile-name");
  const profileRole     = document.getElementById("profile-role");
  const profileMeta     = document.getElementById("profile-meta");

  // Attempt tracker
  const attemptTracker  = document.getElementById("attempt-tracker");
  const attemptDots     = document.getElementById("attempt-dots");
  const attemptCount    = document.getElementById("attempt-count");

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { return "?"; }
    return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  }

  async function setAvatarPhoto(containerEl, initialsEl, src, displayName) {
    // Proxy the image through main process to avoid CSP blocking CDN/S3 URLs
    let imgSrc = src;
    try {
      const res = await window.electronAPI?.fetchProfileImage?.(src);
      if (res?.ok && res.dataUrl) { imgSrc = res.dataUrl; }
    } catch { /* fall through to direct URL */ }

    const img = document.createElement("img");
    img.alt = displayName;
    img.src = imgSrc;
    img.onerror = () => {
      img.remove();
      initialsEl.textContent = initials(displayName);
      initialsEl.style.display = "";
    };
    initialsEl.style.display = "none";
    containerEl.appendChild(img);
  }

  // ── Guard: must be authenticated ─────────────────────────────────────────
  let sessionUser = null;
  try {
    sessionUser = await window.electronAPI?.getAuthUser?.();
  } catch { sessionUser = null; }

  if (!sessionUser) {
    window.location.href = "./login.html";
    return;
  }

  // Populate topbar immediately from session data (no network wait)
  const displayNameFallback = sessionUser.name || sessionUser.email || "User";
  welcomeEl.textContent      = `Welcome, ${String(displayNameFallback).trim().split(/\s+/)[0]}`;

  // ── Fetch candidate profile ──────────────────────────────────────────────
  let profile = null;
  try {
    const res = await window.electronAPI?.getCandidateProfile?.();
    if (res?.success && res.data) {
      profile = res.data;
    } else if (!res?.success) {
      const msg = res?.message || "";
      // Session expired mid-use (refresh also failed in main) — force re-login
      if (msg.includes("Session expired") || msg.includes("Not authenticated")) {
        window.location.href = "./login.html";
        return;
      }
    }
  } catch { profile = null; }

  if (profile) {
    const displayName = profile.name || displayNameFallback;

    // Update welcome
    welcomeEl.textContent = `Welcome, ${String(displayName).trim().split(/\s+/)[0]}`;

    // Profile card
    profileName.innerHTML = "";
    profileName.textContent = displayName;

    profileRole.innerHTML = "";
    profileRole.textContent = profile.role || "";

    // Profile card photo
    if (profile.profile_photo) {
      setAvatarPhoto(profileAvatar, profileInitials, profile.profile_photo, displayName);
    } else {
      profileInitials.textContent = initials(displayName);
    }

    // Meta row: email + phone
    profileMeta.innerHTML = "";
    if (profile.email) {
      profileMeta.innerHTML += `
        <span class="profile-card__meta-item">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
          ${escHtml(profile.email)}
        </span>`;
    }
    if (profile.phone_number) {
      profileMeta.innerHTML += `
        <span class="profile-card__meta-item">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.61 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l.98-.98a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          ${escHtml(profile.phone_number)}
        </span>`;
    }

    // ── Attempt tracker ──────────────────────────────────────────────────
    const used = Number(profile.interview_attempts_used) || 0;
    const max  = Number(profile.max_interviews_allowed)  || 0;

    // interview_attempts_remaining may be absent from the API payload. Number()
    // of a missing field yields NaN (NOT null/undefined), so `?? fallback` never
    // fired — leaving remaining = NaN, which broke the "used all attempts" gate
    // (NaN <= 0 is false) and rendered "NaN of X remaining". Validate explicitly.
    const rawRemaining = Number(profile.interview_attempts_remaining);
    const remaining = Number.isFinite(rawRemaining) ? rawRemaining : Math.max(0, max - used);

    if (max > 0) {
      attemptTracker.style.display = "";
      attemptDots.innerHTML = "";
      // Clamp dot rendering — max comes straight from the API; a bad value
      // (e.g. 1000) would otherwise flood the DOM.
      const dotCount = Math.min(max, 10);
      for (let i = 0; i < dotCount; i++) {
        const dot = document.createElement("span");
        dot.className = "attempt-dot" + (i < used ? " used" : "");
        attemptDots.appendChild(dot);
      }
      attemptCount.textContent = window.t
        ? window.t("dashboard.attemptsRemaining", { remaining, max })
        : `${remaining} of ${max} remaining`;
      if (remaining <= 0) { attemptCount.classList.add("exhausted"); }
    }

    // ── Gate the button ──────────────────────────────────────────────────
    if (remaining <= 0) {
      takeBtn.disabled = true;
      dashNote.textContent = window.t
        ? window.t("dashboard.attemptsExhausted")
        : "You've used all your interview attempts. Contact support if you need more.";
      dashNote.classList.add("exhausted-note");
    }

  } else {
    // Profile fetch failed — clear skeletons with session data
    profileName.textContent     = displayNameFallback;
    profileRole.textContent     = sessionUser.role || "";
    profileMeta.innerHTML       = "";
    profileInitials.textContent = initials(displayNameFallback);
  }

  // ── Take interview ───────────────────────────────────────────────────────
  const takeBtnHTML = takeBtn.innerHTML; // capture original markup for restore
  takeBtn.addEventListener("click", () => {
    if (takeBtn.disabled) { return; }
    // Fail loud if the bridge method is missing — never spin forever silently.
    if (typeof window.electronAPI?.startInterview !== "function") {
      dashNote.textContent = "Unable to start — please restart the app.";
      dashNote.classList.add("exhausted-note");
      return;
    }
    takeBtn.disabled = true;
    takeBtn.innerHTML = "Starting&hellip;";
    window.electronAPI.startInterview();
    // Watchdog: successful navigation tears down this page (timer dies with it).
    // If the timer fires, navigation never happened — restore the button.
    setTimeout(() => {
      takeBtn.disabled = false;
      takeBtn.innerHTML = takeBtnHTML;
      dashNote.textContent = "That took too long. Please try again.";
      dashNote.classList.add("exhausted-note");
    }, 6000);
  });

  // ── Logout ───────────────────────────────────────────────────────────────
  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    logoutBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      Logging out…`;
    try { await window.electronAPI?.logout?.(); } catch { /* clear locally regardless */ }
    window.location.href = "./login.html";
  });
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
