/**
 * src/renderer/dashboard.js
 * ─────────────────────────
 * Dashboard controller. Renders the logged-in user (display-safe fields pulled
 * from main) and hands off to the security check on "Take interview". Tokens
 * never live here — main holds them and reuses them for the interview.
 */

"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const avatarEl = document.getElementById("avatar");
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role");
  const welcomeEl = document.getElementById("welcome");
  const takeBtn = document.getElementById("take-interview-btn");
  const logoutBtn = document.getElementById("logout-btn");

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) { return "?"; }
    return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  }

  // Load the session user; if not authenticated, bounce to login.
  let user = null;
  try {
    user = await window.electronAPI?.getAuthUser?.();
  } catch {
    user = null;
  }
  if (!user) {
    window.location.href = "./login.html";
    return;
  }

  const firstName = String(user.name || "there").trim().split(/\s+/)[0];
  welcomeEl.textContent = `Welcome, ${firstName}`;
  nameEl.textContent = user.name || user.email || "User";
  roleEl.textContent = user.role || "";
  avatarEl.textContent = initials(user.name || user.email);

  // ── Take interview → security check (main sets the session + navigates) ──
  takeBtn.addEventListener("click", () => {
    takeBtn.disabled = true;
    takeBtn.textContent = "Starting…";
    window.electronAPI?.startInterview?.();
  });

  // ── Logout ──────────────────────────────────────────────────────────────
  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    logoutBtn.textContent = "Logging out…";
    try {
      await window.electronAPI?.logout?.();
    } catch {
      // clear locally regardless
    }
    window.location.href = "./login.html";
  });
});
