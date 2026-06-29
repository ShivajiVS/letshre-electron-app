/**
 * src/renderer/login.js
 * ─────────────────────
 * Login screen controller. Credentials go to main via IPC — tokens never
 * touch the renderer. The renderer only learns success/failure + display-safe
 * user fields. Ctrl+V paste works natively in both input fields.
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const form          = document.getElementById("login-form");
  const emailEl       = document.getElementById("email");
  const passwordEl    = document.getElementById("password");
  const errorEl       = document.getElementById("auth-error");
  const submitBtn     = document.getElementById("submit-btn");
  const showPasswordCb = document.getElementById("show-password");

  // ── Show / hide password via checkbox ────────────────────────────────────
  showPasswordCb.addEventListener("change", () => {
    passwordEl.type = showPasswordCb.checked ? "text" : "password";
  });

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
    submitBtn.disabled  = loading;
    submitBtn.textContent = loading ? "Signing in…" : "Sign in";
    emailEl.disabled    = loading;
    passwordEl.disabled = loading;
    showPasswordCb.disabled = loading;
  }

  // ── Form submit ───────────────────────────────────────────────────────────
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    const email    = emailEl.value.trim();
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
