"use strict";

// End-to-end tests for the security-check page: `electron test/e2e/run.js`.
// Loads the real assets/preflight.html behind test/e2e/fakePreload.js and
// answers every bridge call from the scenario being run.

require("../_setup");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const ROOT = path.join(__dirname, "../..");
const PAGE = path.join(ROOT, "assets/preflight.html");
const PRELOAD = path.join(__dirname, "fakePreload.js");
const ROOT_URL = pathToFileURL(ROOT).href;

const SCENARIO_TIMEOUT_MS = 30000;
const OVERALL_TIMEOUT_MS = 240000;

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "si-e2e-")));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const localeManager = require("../../src/main/localeManager");
const { scenarios } = require("./scenarios");
const { delay } = require("./util");

function out(line) {
  process.stdout.write(`${line}\n`);
}

const contexts = new Map();

class ScenarioContext {
  constructor(name, options) {
    this.name = name;
    this.locale = options.locale || "en";
    this.size = { width: options.width || 1100, height: options.height || 900 };
    this.calls = [];
    this.requests = [];
    this.consoleErrors = [];
    this.missingKeys = [];
    this.unhandled = [];
    this.handlers = new Map();
    this.scans = [];
    this.win = null;
    this.en = localeManager.getTranslations("en");
    this.bundle = localeManager.getTranslations(this.locale);
    this.installDefaults();
  }

  installDefaults() {
    this.handle("getI18nBootstrap", () => ({ locale: this.locale, bundle: this.bundle }));
    this.handle("getTranslations", (locale) => localeManager.getTranslations(locale));
    this.handle("getLocale", () => this.locale);
    this.handle("getSupportedLocales", () => localeManager.getSupportedLocales());
    this.handle("getAppVersion", () => "0.0.0-e2e");
    this.handle("getAppList", () => ({ displayNames: {} }));
    this.handle("canElevate", () => false);
    this.handle("getSupportInfo", () => ({ available: false }));
    this.handle("getAuditLog", () => []);
    this.handle("getUpdateState", () => ({ state: "idle" }));
    this.handle("loadPermissionsPage", () => ({ ok: true }));
    this.handle("runPreflight", (token) => {
      const script = this.scans.length > 1 ? this.scans.shift() : this.scans[0];
      if (!script) {
        throw new Error("no scan scripted");
      }
      return script(token, this);
    });
  }

  handle(method, fn) {
    this.handlers.set(method, fn);
  }

  /** Queue what the next runPreflight does; the last one repeats. */
  onScan(fn) {
    this.scans.push(fn);
  }

  async invoke(method, args) {
    this.calls.push({ method, args });
    const fn = this.handlers.get(method);
    if (!fn) {
      this.unhandled.push(method);
      throw new Error(`e2e: no handler for ${method}`);
    }
    return fn(...args);
  }

  callsTo(method) {
    return this.calls.filter((c) => c.method === method);
  }

  push(channel, data) {
    this.win.webContents.send("e2e:push", channel, data);
  }

  progress(data) {
    this.push("preflight-progress", data);
  }

  live(data) {
    this.push("push-pre-proceed-status", data);
  }

  t(key, params) {
    const value = key.split(".").reduce((node, part) => node?.[part], this.bundle);
    if (typeof value !== "string") {
      throw new Error(`missing translation ${key}`);
    }
    return params
      ? value.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
      : value;
  }

  eval(code) {
    return this.win.webContents.executeJavaScript(code, true);
  }

  q(selector, expr) {
    return this.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
        `return el ? (${expr}) : null; })()`
    );
  }

  text(selector) {
    return this.q(selector, "el.textContent.trim()");
  }

  hasClass(selector, cls) {
    return this.q(selector, `el.classList.contains(${JSON.stringify(cls)})`);
  }

  isHidden(selector) {
    return this.q(selector, "el.hidden || el.closest('[hidden]') !== null");
  }

  click(selector) {
    return this.q(selector, "(el.click(), true)").then((ok) => {
      if (!ok) {
        throw new Error(`nothing to click at ${selector}`);
      }
    });
  }

  async until(code, message, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await this.eval(code);
      if (last) {
        return last;
      }
      await delay(40);
    }
    throw new Error(`timed out waiting for ${message || code} (last: ${JSON.stringify(last)})`);
  }

  untilText(selector, expected, timeoutMs) {
    return this.until(
      `document.querySelector(${JSON.stringify(selector)})?.textContent.trim() === ${JSON.stringify(expected)}`,
      `${selector} to read "${expected}"`,
      timeoutMs
    ).catch(async (err) => {
      const actual = await this.text(selector);
      err.message += `; actual: ${JSON.stringify(actual)}`;
      throw err;
    });
  }

  async untilCalls(method, count, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.callsTo(method).length >= count) {
        return this.callsTo(method);
      }
      await delay(20);
    }
    throw new Error(`expected ${count} ${method} call(s), got ${this.callsTo(method).length}`);
  }
}

ipcMain.handle("e2e:invoke", (event, method, args) => {
  const ctx = contexts.get(event.sender.id);
  if (!ctx) {
    throw new Error("e2e: unknown window");
  }
  return ctx.invoke(method, args);
});

ipcMain.on("e2e:send", (event, method, args) => {
  contexts.get(event.sender.id)?.calls.push({ method, args });
});

async function openPage(ctx, index, query) {
  const ses = session.fromPartition(`e2e-${index}`);
  ses.webRequest.onBeforeRequest((details, callback) => {
    ctx.requests.push(details.url);
    callback({ cancel: !details.url.startsWith("file:") });
  });

  const win = new BrowserWindow({
    show: false,
    width: ctx.size.width,
    height: ctx.size.height,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      session: ses,
    },
  });
  ctx.win = win;
  contexts.set(win.webContents.id, ctx);

  win.webContents.on("console-message", ({ level, message }) => {
    if (level === "error") {
      ctx.consoleErrors.push(message);
    }
    if (/\[i18n\] missing key/.test(message)) {
      ctx.missingKeys.push(message);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    ctx.consoleErrors.push(`renderer gone: ${details.reason}`);
  });

  await win.loadFile(PAGE, query ? { query } : undefined);
  await ctx.until("!document.documentElement.classList.contains('i18n-pending')", "i18n reveal");
}

function checkRequests(ctx) {
  const stray = ctx.requests.filter((url) => !url.startsWith(`${ROOT_URL}/`));
  if (stray.length > 0) {
    throw new Error(`page made non-local requests: ${stray.join(", ")}`);
  }
}

async function runScenario(scenario, index) {
  const ctx = new ScenarioContext(scenario.name, scenario);
  const started = Date.now();
  let error = null;
  let timer;
  try {
    scenario.setup?.(ctx);
    const body = (async () => {
      await openPage(ctx, index, scenario.query);
      await scenario.run(ctx);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("scenario timed out")), SCENARIO_TIMEOUT_MS);
    });
    await Promise.race([body, timeout]);

    checkRequests(ctx);
    if (ctx.unhandled.length > 0) {
      throw new Error(`unexpected bridge calls: ${ctx.unhandled.join(", ")}`);
    }
    if (ctx.missingKeys.length > 0) {
      throw new Error(`missing translations: ${ctx.missingKeys.join("; ")}`);
    }
    const allowed = scenario.allowConsoleErrors;
    const errors = ctx.consoleErrors.filter((m) => !(allowed && allowed.test(m)));
    if (errors.length > 0) {
      throw new Error(`console errors: ${errors.join(" | ")}`);
    }
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(timer);
    if (ctx.win && !ctx.win.isDestroyed()) {
      contexts.delete(ctx.win.webContents.id);
      ctx.win.destroy();
    }
  }
  return { name: scenario.name, ms: Date.now() - started, error };
}

async function main() {
  await app.whenReady();
  const only = process.env.E2E_ONLY;
  const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;
  const results = [];
  for (let i = 0; i < selected.length; i += 1) {
    const result = await runScenario(selected[i], i);
    results.push(result);
    out(`${result.error ? "FAIL" : "ok  "} ${result.name} (${result.ms}ms)`);
    if (result.error) {
      out(
        `     ${String(result.error.stack || result.error)
          .split("\n")
          .slice(0, 4)
          .join("\n     ")}`
      );
    }
  }
  const failed = results.filter((r) => r.error);
  out("");
  out(`e2e: ${results.length - failed.length} passed, ${failed.length} failed`);
  failed.forEach((r) => out(`  - ${r.name}: ${r.error.message}`));
  app.exit(failed.length > 0 || results.length === 0 ? 1 : 0);
}

setTimeout(() => {
  out(`e2e: gave up after ${OVERALL_TIMEOUT_MS / 1000}s`);
  app.exit(1);
}, OVERALL_TIMEOUT_MS).unref();

main().catch((err) => {
  out(`e2e: harness error: ${err.stack || err}`);
  app.exit(1);
});
