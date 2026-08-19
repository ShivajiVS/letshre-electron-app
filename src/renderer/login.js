/**
 * Login screen controller. Credentials go to main via IPC — tokens never
 * touch the renderer. Main never returns free-text error messages (backend
 * wording is unlocalized and can leak internal detail); it returns a stable
 * `code` that this file maps to a translated string. Ctrl+V paste works
 * natively in both input fields.
 */

"use strict";

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
}

// Maps authManager's AUTH_ERROR codes (see src/main/authManager.js) to i18n
// keys. The server's own message text is never shown — only logged in main —
// so UI copy stays consistent across locales regardless of backend wording.
const AUTH_ERROR_KEYS = {
  invalid_credentials: ["login.errors.invalidCredentials", "Incorrect email or password."],
  missing_fields: ["login.errors.missingFields", "Please enter your email and password."],
  invalid_email: ["login.errors.invalidEmail", "Please enter a valid email address."],
  account_inactive: [
    "login.errors.accountInactive",
    "Your account is inactive. Contact support for help.",
  ],
  wrong_role: [
    "login.errors.wrongRole",
    "This account isn't a candidate account. Please use the correct portal.",
  ],
  rate_limited: ["login.errors.rateLimited", "Too many attempts. Please wait and try again."],
  rate_limited_countdown: [
    "login.errors.rateLimitedCountdown",
    "Too many attempts. Please wait {seconds}s and try again.",
  ],
  server_error: [
    "login.errors.serverError",
    "Something went wrong on our end. Please try again shortly.",
  ],
  network_error: [
    "login.errors.network",
    "Can't reach the server. Check your internet connection and try again.",
  ],
  timeout: ["login.errors.timeout", "That took too long. Please try again."],
  malformed_response: [
    "login.errors.serverError",
    "Something went wrong on our end. Please try again shortly.",
  ],
  unknown: ["login.errors.generic", "Login failed. Please try again."],
};

/** Basic shape check — catches typos before a wasted round trip. Not RFC-exhaustive on purpose. */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Rejects if `promise` doesn't settle within `ms` — guards a wedged IPC channel. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

document.addEventListener("DOMContentLoaded", async () => {
  if (window.i18n?.ready) {
    // Guarantees window.t reflects the loaded bundle before any error can be
    // shown — without this a slow locale fetch can race an error message
    // into rendering in stale/default English.
    await window.i18n.ready;
  }

  const form = document.getElementById("login-form");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const errorEl = document.getElementById("auth-error");
  const submitBtn = document.getElementById("submit-btn");
  const showPasswordCb = document.getElementById("show-password");

  showPasswordCb.addEventListener("change", () => {
    passwordEl.type = showPasswordCb.checked ? "text" : "password";
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add("show");
  }
  function showErrorForCode(code, params) {
    const [key, fallback] = AUTH_ERROR_KEYS[code] || AUTH_ERROR_KEYS.unknown;
    showError(tr(key, fallback, params));
  }
  function clearError() {
    errorEl.textContent = "";
    errorEl.classList.remove("show");
  }
  function setLoading(loading) {
    submitBtn.disabled = loading;
    submitBtn.textContent = loading
      ? tr("login.loading", "Signing in…")
      : tr("login.submit", "Sign in");
    emailEl.disabled = loading;
    passwordEl.disabled = loading;
    showPasswordCb.disabled = loading;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    // Defensive caps mirror ipcHandlers.js — well above any real input, just
    // insurance against a pathological paste.
    const email = emailEl.value.trim().slice(0, 254);
    const password = passwordEl.value.slice(0, 256);

    if (!email || !password) {
      showErrorForCode("missing_fields");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      showErrorForCode("invalid_email");
      return;
    }

    if (!window.electronAPI?.login) {
      showError(tr("login.errors.unavailable", "Login is unavailable in this environment."));
      return;
    }

    setLoading(true);
    try {
      // 20s outer bound: main's own axios call always resolves within 15s, so
      // this only guards against a wedged IPC channel, not a slow server.
      const result = await withTimeout(window.electronAPI.login(email, password), 20000);

      if (result?.success) {
        window.location.href = "./dashboard.html";
        return;
      }

      if (result?.code === "rate_limited" && result.retryAfterSeconds) {
        showErrorForCode("rate_limited_countdown", { seconds: result.retryAfterSeconds });
      } else {
        showErrorForCode(result?.code || "unknown");
      }
      setLoading(false);
    } catch {
      // Never surface err.message here — it can be a raw Node/axios string
      // (e.g. "getaddrinfo ENOTFOUND ..."), not something to show a candidate.
      showErrorForCode("unknown");
      setLoading(false);
    }
  });
});
