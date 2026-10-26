"use strict";

// The proctoring log and the held auto-submit the site hands over: when each
// is sent, how failures are retried, and what survives a restart.

const { test, mock, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");

const { API_BASE_URL } = require("../src/shared/constants");

const PROTOCOL_HANDLER = require.resolve("../src/main/protocolHandler");
const AUTH_MANAGER = require.resolve("../src/main/authManager");
const OUTBOX = require.resolve("../src/main/backendOutbox");
const REPORT_STORE = require.resolve("../src/main/reportStore");

let mainToken = "main-token";
const stub = (file, exports) => {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub(PROTOCOL_HANDLER, { getCurrentAccessToken: () => mainToken });
stub(AUTH_MANAGER, { getTokens: () => null });
after(() => {
  delete require.cache[PROTOCOL_HANDLER];
  delete require.cache[AUTH_MANAGER];
});

const LOG_URL = `${API_BASE_URL}/user/v1/candidate/interview/proctoring/log/`;
const SUBMIT_URL = `${API_BASE_URL}/user/v1/candidate/interview/ai/auto_submit/force/`;

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

const batch = (sessionId = "sess-1", records = [{ event_type: "frame" }]) => ({
  interview_id: "int-9",
  session_id: sessionId,
  run_id: "run-1",
  source: "cv_detect",
  event_type: "batch_proctoring_logs",
  payload: { total_records: records.length, records },
});

let outbox;
let store;
let dir;
let posts;
let respond;

function load() {
  delete require.cache[OUTBOX];
  delete require.cache[REPORT_STORE];
  store = require(REPORT_STORE);
  store.init(dir, key);
  outbox = require(OUTBOX);
}

const key = crypto.randomBytes(32);

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
  mainToken = "main-token";
  posts = [];
  respond = async () => ({ data: {} });
  mock.method(axios, "post", async (url, body, config) => {
    posts.push({ url, body, auth: config.headers.Authorization });
    return respond(url, body);
  });
  load();
});

afterEach(() => {
  outbox._internal.reset();
  mock.restoreAll();
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Proctoring log ──────────────────────────────────────────────────────────

test("a handed-over log is posted once, unchanged, with the site's token", async () => {
  const sent = batch();
  assert.deepStrictEqual(outbox.queueProctoringLog(sent, "site-token"), { ok: true });
  await settle();

  assert.deepStrictEqual(posts, [{ url: LOG_URL, body: sent, auth: "Bearer site-token" }]);
  assert.deepStrictEqual(outbox._internal.items(), []);
  assert.ok(!fs.existsSync(path.join(dir, store.FILE_NAME)));
});

test("without a token from the site, the app's own is used", async () => {
  outbox.queueProctoringLog(batch());
  await settle();
  assert.strictEqual(posts[0].auth, "Bearer main-token");
});

test("a malformed log is refused and nothing is queued", () => {
  for (const bad of [null, {}, { ...batch(), session_id: "" }, { ...batch(), payload: {} }]) {
    assert.deepStrictEqual(outbox.queueProctoringLog(bad), { ok: false, error: "invalid batch" });
  }
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("handing over the same session's log again replaces it: still one batch", async () => {
  respond = async () => {
    throw new Error("offline");
  };
  outbox.queueProctoringLog(batch("sess-1", [{ n: 1 }]));
  await settle();
  outbox.queueProctoringLog(batch("sess-1", [{ n: 1 }, { n: 2 }]));
  await settle();

  const items = outbox._internal.items();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].body.payload.records.length, 2);
});

test("a network error keeps the log and retries with growing backoff", async () => {
  respond = async () => {
    throw new Error("ECONNRESET");
  };
  outbox.queueProctoringLog(batch());
  await settle();
  assert.strictEqual(posts.length, 1);

  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 2, "first retry after 2s");

  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 2, "the second wait is longer");

  respond = async () => ({ data: {} });
  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 3);
  assert.deepStrictEqual(outbox._internal.items(), []);
});

for (const status of [500, 502, 503, 504, 408, 429]) {
  test(`a ${status} keeps the log queued`, async () => {
    respond = async () => {
      throw httpError(status);
    };
    outbox.queueProctoringLog(batch());
    await settle();
    assert.strictEqual(outbox._internal.items().length, 1);
  });
}

for (const status of [400, 403, 404, 413, 422]) {
  test(`a ${status} drops the log`, async () => {
    respond = async () => {
      throw httpError(status);
    };
    outbox.queueProctoringLog(batch());
    await settle();
    assert.deepStrictEqual(outbox._internal.items(), []);
  });
}

test("a 401 on the site's token retries with the app's own", async () => {
  respond = async () => {
    if (posts.length === 1) {
      throw httpError(401);
    }
    return { data: {} };
  };
  outbox.queueProctoringLog(batch(), "expired-site-token");
  await settle();
  mock.timers.tick(2000);
  await settle();

  assert.deepStrictEqual(
    posts.map((p) => p.auth),
    ["Bearer expired-site-token", "Bearer main-token"]
  );
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("with no token at all the log waits, then goes once there is one", async () => {
  mainToken = null;
  outbox.queueProctoringLog(batch());
  await settle();
  assert.strictEqual(posts.length, 0);

  mainToken = "main-token";
  mock.timers.tick(2000);
  await settle();
  assert.strictEqual(posts.length, 1);
});

// ─── Held auto-submit ────────────────────────────────────────────────────────

const submit = {
  interviewId: "int-9",
  sessionId: "sess-1",
  reason: "electron_security",
  answer: "draft",
};

test("a pending auto-submit is held, not sent, while the site is sending it", async () => {
  outbox.holdSubmit(submit, "site-token");
  await outbox.flush();
  assert.strictEqual(posts.length, 0);
  assert.strictEqual(outbox._internal.items()[0].held, true);
});

test("a settled auto-submit is dropped and never sent", async () => {
  outbox.holdSubmit(submit, "site-token");
  outbox.settleSubmit("sess-1");
  outbox.releaseHeld("interview window closed");
  await settle();
  assert.strictEqual(posts.length, 0);
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("when the window closes first, the app sends the held auto-submit", async () => {
  outbox.holdSubmit(submit, "site-token");
  outbox.releaseHeld("interview window closed");
  await settle();

  assert.deepStrictEqual(posts, [
    {
      url: SUBMIT_URL,
      body: {
        interview_id: "int-9",
        session_id: "sess-1",
        reason: "electron_security",
        answer: "draft",
      },
      auth: "Bearer site-token",
    },
  ]);
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("a refused auto-submit (usually already submitted) is dropped", async () => {
  respond = async () => {
    throw httpError(400);
  };
  outbox.holdSubmit(submit);
  outbox.releaseHeld("interview window closed");
  await settle();
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("a held auto-submit doesn't hold up the log behind it", async () => {
  outbox.holdSubmit(submit);
  outbox.queueProctoringLog(batch());
  await settle();
  assert.deepStrictEqual(
    posts.map((p) => p.url),
    [LOG_URL]
  );
  assert.strictEqual(outbox._internal.items().length, 1);
});

test("an auto-submit without ids is refused", () => {
  assert.deepStrictEqual(outbox.holdSubmit({ sessionId: "s" }), {
    ok: false,
    error: "invalid submit",
  });
  assert.deepStrictEqual(outbox._internal.items(), []);
});

// ─── Restart ─────────────────────────────────────────────────────────────────

test("unsent items survive a restart; a held auto-submit goes out after relaunch", async () => {
  respond = async () => {
    throw new Error("offline");
  };
  outbox.queueProctoringLog(batch());
  outbox.holdSubmit(submit, "site-token");
  await settle();
  assert.strictEqual(store.load().length, 2);

  // Quit and relaunch.
  outbox._internal.reset();
  load();
  posts = [];
  respond = async () => ({ data: {} });

  assert.strictEqual(outbox.restore(), 2);
  await settle();

  assert.deepStrictEqual(
    posts.map((p) => p.url),
    [LOG_URL, SUBMIT_URL]
  );
  assert.deepStrictEqual(store.load(), []);
});

test("items older than a week are dropped on restore", () => {
  store.save([
    {
      id: "old",
      kind: "proctoring_log",
      key: "log:s",
      body: batch(),
      token: null,
      held: false,
      queuedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    },
  ]);
  assert.strictEqual(outbox.restore(), 0);
  assert.deepStrictEqual(outbox._internal.items(), []);
});

test("tokens and records are unreadable at rest", async () => {
  respond = async () => {
    throw new Error("offline");
  };
  outbox.queueProctoringLog(batch("sess-1", [{ label: "cell phone" }]), "site-token-secret");
  await settle();
  const raw = fs.readFileSync(path.join(dir, store.FILE_NAME));
  assert.ok(!raw.includes(Buffer.from("site-token-secret")));
  assert.ok(!raw.includes(Buffer.from("cell phone")));
});
