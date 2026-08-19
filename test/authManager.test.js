"use strict";

/**
 * Tests authManager.login()'s failure classification: every branch must
 * resolve to a stable AUTH_ERROR code, never the backend's raw message text
 * (that's the bug this module fixes — see src/renderer/login.js).
 *
 * axios.post is mocked per-test via t.mock.method (auto-restored after each
 * test) — no real network calls. authManager holds module-level session
 * state shared across tests in this file, so every test resets it via
 * logout() first rather than relying on test execution order.
 */

const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const authManager = require("../src/main/authManager");

const { AUTH_ERROR } = authManager;

/** Mocks axios.post for this test and clears any session left by a prior test. */
async function freshLogin(t, loginResponder, email = "a@b.com", password = "x") {
  t.mock.method(axios, "post", async (url, ...rest) => {
    if (String(url).includes("logout")) {
      return { data: { success: true } };
    }
    return loginResponder(url, ...rest);
  });
  await authManager.logout(); // no-op network-wise if no session yet; always clears state
  return authManager.login(email, password);
}

function resolved(data) {
  return async () => ({ data });
}
function rejected(err) {
  return async () => {
    throw err;
  };
}

const VALID_SUCCESS_BODY = {
  success: true,
  message: "Login successful.",
  data: {
    id: "a2e74dc9-22bc-4af1-b006-e00e351d1383",
    name: "kondeti shivaji",
    username: "shivajikv55",
    email: "shivajikv55@gmail.com",
    phone_number: "7671831428",
    role: "Candidate",
    is_active: true,
    is_superuser: false,
    is_profile_completed: false,
    access_token: "access-token",
    refresh_token: "refresh-token",
  },
};

test("login: success returns display-safe user, no tokens, no message", async (t) => {
  const result = await freshLogin(
    t,
    resolved(VALID_SUCCESS_BODY),
    "shivajikv55@gmail.com",
    "correct-password"
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.code, undefined);
  assert.strictEqual(result.message, undefined);
  assert.strictEqual(result.user.email, "shivajikv55@gmail.com");
  assert.strictEqual(result.user.access_token, undefined);
});

test("login: success:false body (200) classifies as invalid_credentials, never forwards server message", async (t) => {
  const result = await freshLogin(
    t,
    resolved({ success: false, message: "Invalid credentials." })
  );
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, AUTH_ERROR.INVALID_CREDENTIALS);
  assert.strictEqual(result.message, undefined);
});

test("login: HTTP 401 classifies as invalid_credentials", async (t) => {
  const result = await freshLogin(
    t,
    rejected({ response: { status: 401, data: { message: "bad creds" }, headers: {} } })
  );
  assert.strictEqual(result.code, AUTH_ERROR.INVALID_CREDENTIALS);
});

test("login: HTTP 400 classifies as invalid_credentials", async (t) => {
  const result = await freshLogin(t, rejected({ response: { status: 400, headers: {} } }));
  assert.strictEqual(result.code, AUTH_ERROR.INVALID_CREDENTIALS);
});

test("login: HTTP 429 classifies as rate_limited and parses Retry-After", async (t) => {
  const result = await freshLogin(
    t,
    rejected({ response: { status: 429, headers: { "retry-after": "45" } } })
  );
  assert.strictEqual(result.code, AUTH_ERROR.RATE_LIMITED);
  assert.strictEqual(result.retryAfterSeconds, 45);
});

test("login: HTTP 429 without a Retry-After header omits the countdown", async (t) => {
  const result = await freshLogin(t, rejected({ response: { status: 429, headers: {} } }));
  assert.strictEqual(result.code, AUTH_ERROR.RATE_LIMITED);
  assert.strictEqual(result.retryAfterSeconds, undefined);
});

test("login: HTTP 5xx classifies as server_error", async (t) => {
  const result = await freshLogin(t, rejected({ response: { status: 503, headers: {} } }));
  assert.strictEqual(result.code, AUTH_ERROR.SERVER_ERROR);
});

test("login: no response (DNS/offline) classifies as network_error, never leaks err.message", async (t) => {
  const result = await freshLogin(
    t,
    rejected(new Error("getaddrinfo ENOTFOUND api.letshyre.com"))
  );
  assert.strictEqual(result.code, AUTH_ERROR.NETWORK_ERROR);
  assert.strictEqual(JSON.stringify(result).includes("ENOTFOUND"), false);
});

test("login: ECONNABORTED classifies as timeout", async (t) => {
  const err = new Error("timeout of 15000ms exceeded");
  err.code = "ECONNABORTED";
  const result = await freshLogin(t, rejected(err));
  assert.strictEqual(result.code, AUTH_ERROR.TIMEOUT);
});

test("login: success body missing access_token classifies as malformed_response", async (t) => {
  const result = await freshLogin(
    t,
    resolved({ success: true, data: { id: "x", email: "a@b.com", role: "Candidate" } })
  );
  assert.strictEqual(result.code, AUTH_ERROR.MALFORMED_RESPONSE);
});

test("login: is_active false blocks with account_inactive, does not establish a session", async (t) => {
  const body = JSON.parse(JSON.stringify(VALID_SUCCESS_BODY));
  body.data.is_active = false;
  const result = await freshLogin(t, resolved(body), "shivajikv55@gmail.com", "correct-password");
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, AUTH_ERROR.ACCOUNT_INACTIVE);
  assert.strictEqual(authManager.getUser(), null);
});

test("login: non-Candidate role blocks with wrong_role, does not establish a session", async (t) => {
  const body = JSON.parse(JSON.stringify(VALID_SUCCESS_BODY));
  body.data.role = "Employer";
  const result = await freshLogin(t, resolved(body), "shivajikv55@gmail.com", "correct-password");
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, AUTH_ERROR.WRONG_ROLE);
  assert.strictEqual(authManager.getUser(), null);
});

test("login: request body always sends role Candidate regardless of caller input", async (t) => {
  let sentBody;
  const result = await freshLogin(
    t,
    async (_url, body) => {
      sentBody = body;
      return { data: VALID_SUCCESS_BODY };
    },
    "shivajikv55@gmail.com",
    "correct-password"
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(sentBody.role, "Candidate");
});
