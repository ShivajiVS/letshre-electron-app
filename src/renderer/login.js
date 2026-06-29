/**
 * src/renderer/login.js
 * ─────────────────────
 * Login screen controller. Talks to the main process via window.electronAPI —
 * credentials go to main, which performs the HTTP login (axios) and keeps the
 * tokens. The renderer only learns success/failure + display-safe user fields.
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const errorEl = document.getElementById("auth-error");
  const submitBtn = document.getElementById("submit-btn");
  const pasteEmailBtn = document.getElementById("paste-email");
  const pastePasswordBtn = document.getElementById("paste-password");
  const togglePasswordBtn = document.getElementById("toggle-password");
  const eyeIcon = document.getElementById("eye-icon");
  const eyeOffIcon = document.getElementById("eye-off-icon");

  // ── Show / hide password ──────────────────────────────────────────────────
  togglePasswordBtn.addEventListener("click", () => {
    const isHidden = passwordEl.type === "password";
    passwordEl.type = isHidden ? "text" : "password";
    eyeIcon.style.display = isHidden ? "none" : "";
    eyeOffIcon.style.display = isHidden ? "" : "none";
    passwordEl.focus();
  });

  // ── Paste from clipboard ──────────────────────────────────────────────────
  async function pasteInto(inputEl) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        inputEl.value = text.trim();
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.focus();
      }
    } catch {
      // Clipboard access denied — silently ignore (user can still type / Ctrl+V)
    }
  }

  pasteEmailBtn.addEventListener("click", () => pasteInto(emailEl));
  pastePasswordBtn.addEventListener("click", () => pasteInto(passwordEl));

  // ── Error helpers ─────────────────────────────────────────────────────────
  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add("show");
  }
  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.remove("show");
  }
  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.textContent = loading ? "Signing in…" : "Sign in";
    emailEl.disabled = loading;
    passwordEl.disabled = loading;
    pasteEmailBtn.disabled = loading;
    pastePasswordBtn.disabled = loading;
    togglePasswordBtn.disabled = loading;
  }

  // ── Form submit ───────────────────────────────────────────────────────────
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) {
      showError("Please enter your email and password.");
      return;
    }

    if (!window.electronAPI?.login) {
      showError("Login is unavailable in this environment.");
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.login(email, password);
      if (result?.success) {
        // Tokens stay in main; just move to the dashboard.
        window.location.href = "./dashboard.html";
        return;
      }
      showError(result?.message || "Login failed. Please try again.");
      setLoading(false);
    } catch (err) {
      showError(err?.message || "Something went wrong. Please try again.");
      setLoading(false);
    }
  });
});
