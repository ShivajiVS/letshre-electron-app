/**
 * src/renderer/dashboard.js
 * ─────────────────────────
 * Dashboard controller. Fetches the candidate profile (name, photo, interview
 * attempts) from main via IPC — tokens never touch the renderer. Gates the
 * "Take interview" button on remaining attempts.
 */

"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const avatarEl        = document.getElementById("avatar");
  const avatarInitials  = document.getElementById("avatar-initials");
  const nameEl          = document.getElementById("user-name");
  const roleEl          = document.getElementById("user-role");
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

  function setAvatarPhoto(containerEl, initialsEl, src, displayName) {
    const img = document.createElement("img");
    img.alt = displayName;
    img.src = src;
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
  nameEl.textContent         = displayNameFallback;
  roleEl.textContent         = sessionUser.role || "";
  avatarInitials.textContent = initials(displayNameFallback);

  // ── Fetch candidate profile ──────────────────────────────────────────────
  let profile = null;
  try {
    const res = await window.electronAPI?.getCandidateProfile?.();
    if (res?.success && res.data) { profile = res.data; }
  } catch { profile = null; }

  if (profile) {
    const displayName = profile.name || displayNameFallback;

    // Update topbar
    nameEl.textContent    = displayName;
    roleEl.textContent    = profile.role || sessionUser.role || "";
    welcomeEl.textContent = `Welcome, ${String(displayName).trim().split(/\s+/)[0]}`;
    avatarInitials.textContent = initials(displayName);

    // Profile photo in topbar avatar
    if (profile.profile_photo) {
      setAvatarPhoto(avatarEl, avatarInitials, profile.profile_photo, displayName);
    }

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
    const used      = Number(profile.interview_attempts_used)      || 0;
    const max       = Number(profile.max_interviews_allowed)       || 0;
    const remaining = Number(profile.interview_attempts_remaining) ?? (max - used);

    if (max > 0) {
      attemptTracker.style.display = "";
      attemptDots.innerHTML = "";
      for (let i = 0; i < max; i++) {
        const dot = document.createElement("span");
        dot.className = "attempt-dot" + (i < used ? " used" : "");
        attemptDots.appendChild(dot);
      }
      attemptCount.textContent = `${remaining} of ${max} remaining`;
      if (remaining <= 0) { attemptCount.classList.add("exhausted"); }
    }

    // ── Gate the button ──────────────────────────────────────────────────
    if (remaining <= 0) {
      takeBtn.disabled = true;
      dashNote.textContent = "You've used all your interview attempts. Contact support if you need more.";
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
  takeBtn.addEventListener("click", () => {
    if (takeBtn.disabled) { return; }
    takeBtn.disabled = true;
    takeBtn.innerHTML = "Starting&hellip;";
    window.electronAPI?.startInterview?.();
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
