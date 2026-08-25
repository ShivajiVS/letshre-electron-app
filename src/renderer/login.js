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

// ─── Field validation ─────────────────────────────────────────────────────
// Hand-mirrored from src/shared/authValidators.js — the renderer is sandboxed
// (no require()), same convention as APP_DISPLAY_NAMES mirroring
// shared/appList.js in preflight.js. test/loginValidators.test.js asserts
// these values haven't drifted from the shared source.
//
// Password complexity is INFORMATIONAL ONLY: it never blocks the Sign In
// click. The backend, not this file, is the actual authority on whether a
// password is valid for a given account — a real account created before this
// policy existed (or with a different one) must still be able to log in.
// Only empty email, malformed email, and empty password block submission.
const EMAIL_MAX_LEN = 254;
const PASSWORD_MAX_LEN = 256;
const PASSWORD_MIN_LEN = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_RULES = [
  { id: "minLength", test: (v) => v.length >= PASSWORD_MIN_LEN },
  { id: "uppercase", test: (v) => /[A-Z]/.test(v) },
  { id: "lowercase", test: (v) => /[a-z]/.test(v) },
  { id: "digit", test: (v) => /\d/.test(v) },
  { id: "symbol", test: (v) => /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/.test(v) },
];

function validateEmail(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    return { valid: false, code: "required" };
  }
  if (v.length > EMAIL_MAX_LEN) {
    return { valid: false, code: "tooLong" };
  }
  if (!EMAIL_REGEX.test(v)) {
    return { valid: false, code: "invalid" };
  }
  return { valid: true, code: null };
}

function validatePassword(value) {
  const v = typeof value === "string" ? value : "";
  if (!v) {
    return { valid: false, code: "required", failedRules: [] };
  }
  if (v.length > PASSWORD_MAX_LEN) {
    return { valid: false, code: "tooLong", failedRules: [] };
  }
  const failedRules = PASSWORD_RULES.filter((r) => !r.test(v)).map((r) => r.id);
  // NOT reflected in `valid` — see the file-level note above. A complexity
  // miss is reported (failedRules is non-empty) but never fails the field.
  return { valid: true, code: null, failedRules };
}

const EMAIL_ERROR_KEYS = {
  required: ["login.errors.emailRequired", "Please enter your email address."],
  tooLong: ["login.errors.emailTooLong", "That email address is too long."],
  // Reuses the existing invalidEmail key (already translated) rather than
  // duplicating the same message under a new key.
  invalid: ["login.errors.invalidEmail", "Please enter a valid email address."],
};

/** Rejects if `promise` doesn't settle within `ms` — guards a wedged IPC channel. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("login-form");
  const emailEl = document.getElementById("email");
  const passwordEl = document.getElementById("password");
  const emailErrorEl = document.getElementById("email-error");
  const passwordErrorEl = document.getElementById("password-error");
  const errorEl = document.getElementById("auth-error");
  const submitBtn = document.getElementById("submit-btn");
  const showPasswordCb = document.getElementById("show-password");

  // A field only shows inline errors after the user has left it once —
  // avoids painting red the instant someone starts typing.
  const touched = { email: false, password: false };

  // Transient render state that renderI18n() below re-derives text from —
  // isLoading drives the submit button label, lastAuthError the banner.
  let isLoading = false;
  let lastAuthError = null; // { code, params } | null

  showPasswordCb.addEventListener("change", () => {
    passwordEl.type = showPasswordCb.checked ? "text" : "password";
  });

  function setFieldError(inputEl, errorEl_, message) {
    if (message) {
      errorEl_.textContent = message;
      errorEl_.classList.add("show");
      inputEl.classList.add("field__input--invalid");
      inputEl.setAttribute("aria-invalid", "true");
    } else {
      errorEl_.textContent = "";
      errorEl_.classList.remove("show");
      inputEl.classList.remove("field__input--invalid");
      inputEl.removeAttribute("aria-invalid");
    }
  }

  /** @returns {boolean} true if the email field is valid (blocks submit if not) */
  function checkEmail() {
    const result = validateEmail(emailEl.value);
    if (!result.valid) {
      const [key, fallback] = EMAIL_ERROR_KEYS[result.code];
      setFieldError(emailEl, emailErrorEl, tr(key, fallback));
      return false;
    }
    setFieldError(emailEl, emailErrorEl, null);
    return true;
  }

  /** Always returns true — password complexity never blocks submit, see file header. */
  function checkPassword() {
    const raw = passwordEl.value;
    if (!raw) {
      setFieldError(
        passwordEl,
        passwordErrorEl,
        tr("login.errors.passwordRequired", "Please enter your password.")
      );
      return false; // emptiness IS a hard blocker, unlike complexity below
    }
    const result = validatePassword(raw);
    if (result.failedRules.length > 0) {
      setFieldError(
        passwordEl,
        passwordErrorEl,
        tr(
          "login.errors.passwordRequirements",
          "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a symbol."
        )
      );
    } else {
      setFieldError(passwordEl, passwordErrorEl, null);
    }
    return true;
  }

  emailEl.addEventListener("blur", () => {
    touched.email = true;
    checkEmail();
  });
  emailEl.addEventListener("input", () => {
    if (touched.email) {
      checkEmail();
    }
  });
  passwordEl.addEventListener("blur", () => {
    touched.password = true;
    checkPassword();
  });
  passwordEl.addEventListener("input", () => {
    if (touched.password) {
      checkPassword();
    }
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add("show");
  }
  function showErrorForCode(code, params) {
    lastAuthError = { code, params };
    const [key, fallback] = AUTH_ERROR_KEYS[code] || AUTH_ERROR_KEYS.unknown;
    showError(tr(key, fallback, params));
  }
  function clearError() {
    lastAuthError = null;
    errorEl.textContent = "";
    errorEl.classList.remove("show");
  }
  function setLoading(loading) {
    isLoading = loading;
    submitBtn.disabled = loading;
    submitBtn.textContent = loading
      ? tr("login.loading", "Signing in…")
      : tr("login.submit", "Sign in");
    emailEl.disabled = loading;
    passwordEl.disabled = loading;
    showPasswordCb.disabled = loading;
  }

  // i18n render hook — re-derives every tr()-rendered string from current
  // state. Registered synchronously below, ahead of the readiness wait, so
  // it runs as part of the pre-reveal pass and never paints English
  // defaults for a non-English locale.
  function renderI18n() {
    submitBtn.textContent = isLoading
      ? tr("login.loading", "Signing in…")
      : tr("login.submit", "Sign in");
    if (lastAuthError) {
      showErrorForCode(lastAuthError.code, lastAuthError.params);
    }
    // Only re-validate fields the user already touched — re-running these
    // must not newly flag an untouched field, and neither call moves focus.
    if (touched.email) {
      checkEmail();
    }
    if (touched.password) {
      checkPassword();
    }
  }
  window.i18n?.registerRenderer(renderI18n);

  if (window.i18n?.ready) {
    // Guarantees window.t reflects the loaded bundle before any error can be
    // shown — without this a slow locale fetch can race an error message
    // into rendering in stale/default English.
    await window.i18n.ready;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();

    // Submit always re-validates every field regardless of touched state —
    // catches autofill and paste-then-immediate-submit, neither of which
    // fires blur.
    touched.email = true;
    touched.password = true;
    const emailOk = checkEmail();
    const passwordOk = checkPassword();

    if (!emailOk || !passwordOk) {
      // Never disable the submit button on validation state (an accessibility
      // anti-pattern — screen reader users get no explanation for an inert
      // button). Instead: show every inline error and move focus to the
      // first invalid field.
      (emailOk ? passwordEl : emailEl).focus();
      return;
    }

    // Defensive caps mirror ipcHandlers.js — well above any real input, just
    // insurance against a pathological paste.
    const email = emailEl.value.trim().slice(0, EMAIL_MAX_LEN);
    const password = passwordEl.value.slice(0, PASSWORD_MAX_LEN);

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
