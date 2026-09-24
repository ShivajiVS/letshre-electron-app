"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { delay, deferred } = require("./util");

const IDS = ["hdmi", "meeting", "screen", "wireless", "browser", "ai", "agent"];
const LIVE_IDS = IDS.filter((id) => id !== "agent");

function pass(id) {
  return { id, status: "pass", reasonKey: `preflightResults.${id}Clear` };
}

function blocked(id, apps) {
  return { id, status: "fail", reasonKey: `preflightResults.${id}Running`, blockedApps: apps };
}

function unverified(id) {
  return { id, status: "unverified", reasonKey: "preflightResults.checkUnverified" };
}

function threats(list) {
  return {
    id: "agent",
    status: "fail",
    reasonKey: "preflightResults.agentThreatsDetected",
    reasonParams: { n: list.length },
    threats: list,
  };
}

function verdicts(overrides = {}) {
  return IDS.map((id) => overrides[id] || pass(id));
}

function result(token, list) {
  const now = Date.now();
  return {
    token,
    scanId: `scan-${now}`,
    verdicts: list,
    canProceed: list.every((v) => v.status === "pass"),
    capturedAt: now,
    expiresAt: now + 120000,
    timings: {},
  };
}

const passScan = (token) => result(token, verdicts());

function liveStatus(overrides = {}) {
  const list = LIVE_IDS.map((id) => overrides[id] || pass(id));
  const dirty = list.filter((v) => v.status === "fail");
  return {
    clean: list.every((v) => v.status === "pass"),
    unverified: list.some((v) => v.status === "unverified") && dirty.length === 0,
    apps: dirty.flatMap((v) => v.blockedApps || []),
    verdicts: list,
  };
}

async function untilAllPassed(ctx) {
  await ctx.untilText("#summary-text", ctx.t("preflightResults.summaryAllPassed"));
  await ctx.untilText("#final-status", ctx.t("preflightResults.allPassed"));
  assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), false);
}

function pageT(ctx, key, params) {
  return ctx.eval(`window.t(${JSON.stringify(key)}, ${JSON.stringify(params || {})})`);
}

function cardTone(ctx, id) {
  return ctx.q(
    `#card-${id}`,
    "['scanning','pass','fail','unverified'].find((t) => el.classList.contains('sc-card--' + t))"
  );
}

function cardTones(ctx) {
  return Promise.all(IDS.map((id) => cardTone(ctx, id)));
}

/** A reload would wipe this, so it proves the page stayed put. */
function markPage(ctx) {
  return ctx.eval("window.__e2eMarker = 1");
}

async function assertSamePage(ctx) {
  assert.strictEqual(await ctx.eval("window.__e2eMarker"), 1, "page reloaded");
}

async function openDialogFrom(ctx, selector) {
  await ctx.click(selector);
  await ctx.until("document.getElementById('kill-dialog').open", "kill dialog to open");
}

const scenarios = [
  {
    name: "all checks pass: Continue opens and the summary says so",
    setup(ctx) {
      ctx.onScan(passScan);
    },
    async run(ctx) {
      await untilAllPassed(ctx);
      for (const id of IDS) {
        assert.strictEqual(await cardTone(ctx, id), "pass", id);
      }
      assert.strictEqual(await ctx.text("#desc-meeting"), ctx.t("preflightResults.meetingClear"));
      const [scan] = ctx.callsTo("runPreflight");
      assert.match(scan.args[0], /^[A-Za-z0-9-]{1,64}$/);

      await ctx.click("#btn-proceed");
      await ctx.untilCalls("loadPermissionsPage", 1);
    },
  },

  {
    name: "streamed verdicts paint their cards before the result arrives",
    setup(ctx) {
      ctx.gate = deferred();
      ctx.onScan(async (token) => {
        ctx.progress({ ...pass("hdmi"), token });
        ctx.progress({ ...blocked("browser", ["chrome.exe"]), token });
        ctx.progress({ id: "agent", phase: "starting", token });
        await ctx.gate.promise;
        return passScan(token);
      });
    },
    async run(ctx) {
      await ctx.until(
        "document.getElementById('card-browser').classList.contains('sc-card--fail')",
        "browser card to fail mid-scan"
      );
      assert.strictEqual(await cardTone(ctx, "hdmi"), "pass");
      assert.strictEqual(await cardTone(ctx, "meeting"), "scanning");
      assert.strictEqual(await ctx.text("#desc-agent"), ctx.t("preflightResults.agentStarting"));
      assert.strictEqual(
        await ctx.text("#summary-text"),
        ctx.t("preflightResults.summaryProgress", { done: 2, total: 7 })
      );
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);
      assert.strictEqual(await ctx.q("#btn-rescan", "el.disabled"), true);

      ctx.gate.resolve();
      await untilAllPassed(ctx);
      assert.strictEqual(await ctx.eval("document.querySelectorAll('.sc-kill-row').length"), 0);
    },
  },

  {
    name: "events from another scan are ignored",
    setup(ctx) {
      ctx.gate = deferred();
      ctx.onScan(async (token) => {
        ctx.progress({ ...blocked("meeting", ["Zoom.exe"]), token: "some-older-scan" });
        ctx.progress({ ...blocked("ai", ["cluely.exe"]) });
        ctx.progress({ ...pass("hdmi"), token });
        await ctx.gate.promise;
        return passScan(token);
      });
    },
    async run(ctx) {
      await ctx.until(
        "document.getElementById('card-hdmi').classList.contains('sc-card--pass')",
        "hdmi card to pass"
      );
      assert.strictEqual(await cardTone(ctx, "meeting"), "scanning");
      assert.strictEqual(await cardTone(ctx, "ai"), "scanning");
      assert.strictEqual(await ctx.eval("document.querySelectorAll('.sc-kill-row').length"), 0);

      ctx.gate.resolve();
      await untilAllPassed(ctx);
      ctx.progress({ ...blocked("meeting", ["Zoom.exe"]), token: "some-older-scan" });
      await delay(200);
      assert.strictEqual(await cardTone(ctx, "meeting"), "pass");
    },
  },

  {
    name: "a result carrying another scan's token never opens Continue",
    allowConsoleErrors: /\[preflight\] scan error/,
    setup(ctx) {
      ctx.onScan(() => passScan("some-older-scan"));
    },
    async run(ctx) {
      await ctx.until(
        "document.getElementById('final-status').classList.contains('sc-status--warn')",
        "scan error status"
      );
      assert.ok((await ctx.text("#final-status")).includes(ctx.t("preflightResults.unknownError")));
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);
      assert.strictEqual(await cardTone(ctx, "meeting"), "unverified");
    },
  },

  {
    name: "Close asks first: Cancel keeps the app, Confirm closes it and rescans",
    setup(ctx) {
      ctx.handle("getAppList", () => ({ displayNames: { "Zoom.exe": "Zoom" } }));
      ctx.handle("killProcess", (name) => ({
        processName: name,
        success: true,
        outcome: "closed",
      }));
      ctx.onScan((token) => result(token, verdicts({ meeting: blocked("meeting", ["Zoom.exe"]) })));
      ctx.onScan(passScan);
    },
    async run(ctx) {
      const row = "#actions-meeting .sc-kill-row[data-process='Zoom.exe']";
      const btn = `${row} .sc-kill-btn`;
      await ctx.until(`!!document.querySelector(${JSON.stringify(btn)})`, "Zoom kill row");
      assert.strictEqual(await cardTone(ctx, "meeting"), "fail");
      assert.strictEqual(await ctx.text(`${row} .sc-kill-name`), "Zoom");
      assert.strictEqual(await ctx.text(`${row} .sc-kill-process`), "Zoom.exe");
      assert.strictEqual(await ctx.text(btn), ctx.t("preflightResults.close"));
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);
      assert.strictEqual(
        await ctx.text("#summary-text"),
        await pageT(ctx, "preflightResults.summaryNeedAttention", { count: 1 })
      );

      await openDialogFrom(ctx, btn);
      assert.strictEqual(await ctx.text("#kill-dialog-list"), "Zoom");
      await ctx.click("#kill-dialog-cancel");
      await ctx.until("!document.getElementById('kill-dialog').open", "dialog to close");
      await delay(150);
      assert.strictEqual(ctx.callsTo("killProcess").length, 0);
      assert.strictEqual(await ctx.text(btn), ctx.t("preflightResults.close"));

      await openDialogFrom(ctx, btn);
      await ctx.click("#kill-dialog-confirm");
      const [kill] = await ctx.untilCalls("killProcess", 1);
      assert.deepStrictEqual(kill.args, ["Zoom.exe"]);
      await ctx.untilText(btn, ctx.t("preflightResults.closed"));

      await ctx.untilCalls("runPreflight", 2, 6000);
      await untilAllPassed(ctx);
    },
  },

  {
    name: "two unverified scans in a row offer support and diagnostics",
    setup(ctx) {
      ctx.handle("getSupportInfo", () => ({ available: true }));
      ctx.onScan((token) => result(token, verdicts({ screen: unverified("screen") })));
    },
    async run(ctx) {
      const rescan = ctx.t("preflight.rescan");
      await ctx.untilText("#final-status", ctx.t("preflightResults.someUnverified", { rescan }));
      assert.strictEqual(await cardTone(ctx, "screen"), "unverified");
      assert.strictEqual(await ctx.isHidden("#support-wrap"), true);
      assert.strictEqual(await ctx.isHidden("#btn-help-support"), false);

      await ctx.click("#btn-rescan");
      await ctx.untilCalls("runPreflight", 2);
      await ctx.until("!document.getElementById('support-wrap').hidden", "support block");
      assert.strictEqual(await ctx.text("#support-text"), ctx.t("preflightResults.supportPrompt"));
      assert.strictEqual(
        await ctx.text("#btn-diagnostics"),
        ctx.t("preflightResults.copyDiagnostics")
      );
      assert.strictEqual(await ctx.isHidden("#btn-contact-support"), false);
      await ctx.click("#btn-contact-support");
      await ctx.untilCalls("openSupport", 1);
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);
    },
  },

  {
    name: "a manual Rescan during the retry countdown replaces the retry",
    allowConsoleErrors: /\[preflight\] scan error/,
    setup(ctx) {
      ctx.onScan(() => {
        throw new Error("probe crashed");
      });
      ctx.onScan(passScan);
    },
    async run(ctx) {
      await ctx.until(
        "document.getElementById('final-status').classList.contains('sc-status--warn')",
        "retry countdown"
      );
      const status = await ctx.text("#final-status");
      assert.ok(status.includes("probe crashed"), status);
      assert.ok(status.includes(ctx.t("preflightResults.attempt", { current: 1, max: 3 })), status);
      assert.strictEqual(await ctx.q("#btn-rescan", "el.disabled"), false);

      await ctx.click("#btn-rescan");
      await untilAllPassed(ctx);
      await delay(6000);
      assert.strictEqual(ctx.callsTo("runPreflight").length, 2);
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), false);
      assert.ok(ctx.consoleErrors.some((m) => m.includes("probe crashed")));
    },
  },

  {
    name: "live pushes after a pass close and reopen Continue",
    setup(ctx) {
      ctx.onScan(passScan);
    },
    async run(ctx) {
      await untilAllPassed(ctx);

      await markPage(ctx);
      ctx.live(liveStatus({ meeting: blocked("meeting", ["Zoom.exe"]) }));
      await ctx.until("document.getElementById('btn-proceed').disabled", "Continue to close");
      assert.strictEqual(await cardTone(ctx, "meeting"), "fail");
      assert.strictEqual(
        await ctx.text("#final-status"),
        await pageT(ctx, "preflightResults.blockedAppLaunched", { names: "Zoom.exe", count: 1 })
      );
      assert.ok(await ctx.hasClass("#final-status", "sc-status--fail"));
      assert.ok(
        await ctx.eval(
          "!!document.querySelector(\"#actions-meeting .sc-kill-row[data-process='Zoom.exe']\")"
        ),
        "Close row for the app opened after the pass"
      );

      // One clean read isn't enough: apps often shut down in stages.
      ctx.live(liveStatus());
      await delay(300);
      assert.strictEqual(await cardTone(ctx, "meeting"), "fail");
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);

      ctx.live(liveStatus());
      await ctx.until("!document.getElementById('btn-proceed').disabled", "Continue to reopen");
      assert.strictEqual(await cardTone(ctx, "meeting"), "pass");
      assert.strictEqual(await ctx.text("#final-status"), ctx.t("preflightResults.allPassed"));
      assert.strictEqual(ctx.callsTo("runPreflight").length, 1, "no rescan needed");
      await assertSamePage(ctx);

      ctx.live({ clean: false, unverified: true, apps: [], verdicts: [] });
      await ctx.until("document.getElementById('btn-proceed').disabled", "Continue to close");
      assert.strictEqual(
        await ctx.text("#final-status"),
        ctx.t("preflightResults.liveUnverified", { rescan: ctx.t("preflight.rescan") })
      );
    },
  },

  {
    name: "switching windows away and back never rescans",
    setup(ctx) {
      ctx.onScan((token) =>
        result(token, verdicts({ browser: blocked("browser", ["chrome.exe"]) }))
      );
    },
    async run(ctx) {
      await ctx.untilText(
        "#final-status",
        ctx.t("preflightResults.resolveAlerts", { rescan: ctx.t("preflight.rescan") })
      );
      await markPage(ctx);
      const before = await cardTones(ctx);
      for (let i = 0; i < 3; i += 1) {
        await ctx.eval(
          "window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); " +
            "document.dispatchEvent(new Event('visibilitychange'))"
        );
        await delay(200);
      }
      await delay(2500);
      assert.strictEqual(ctx.callsTo("runPreflight").length, 1);
      assert.deepStrictEqual(await cardTones(ctx), before);
      await assertSamePage(ctx);
    },
  },

  {
    name: "closing an app yourself confirms quietly without resetting the cards",
    setup(ctx) {
      ctx.gate = deferred();
      ctx.onScan((token) =>
        result(token, verdicts({ browser: blocked("browser", ["chrome.exe"]) }))
      );
      ctx.onScan(async (token) => {
        await ctx.gate.promise;
        return passScan(token);
      });
    },
    async run(ctx) {
      await ctx.until(
        "document.getElementById('card-browser').classList.contains('sc-card--fail')",
        "browser card to fail"
      );
      ctx.live(liveStatus());
      await delay(300);
      assert.strictEqual(await cardTone(ctx, "browser"), "fail");
      ctx.live(liveStatus());
      await ctx.untilCalls("runPreflight", 2, 6000);

      await ctx.untilText("#final-status", ctx.t("preflightResults.checkingAgain"));
      const during = await cardTones(ctx);
      assert.ok(!during.includes("scanning"), `cards were reset: ${during.join(",")}`);
      assert.strictEqual(await ctx.q("#btn-proceed", "el.disabled"), true);

      ctx.gate.resolve();
      await untilAllPassed(ctx);
    },
  },

  {
    name: "a refused Continue confirms in place instead of reloading",
    setup(ctx) {
      ctx.gate = deferred();
      ctx.handle("loadPermissionsPage", () => ({ ok: false, reason: "dirty" }));
      ctx.onScan(passScan);
      ctx.onScan(async (token) => {
        await ctx.gate.promise;
        return passScan(token);
      });
    },
    async run(ctx) {
      await untilAllPassed(ctx);
      await markPage(ctx);
      await ctx.click("#btn-proceed");
      await ctx.untilCalls("loadPermissionsPage", 1);
      await ctx.untilCalls("runPreflight", 2);
      await ctx.untilText("#final-status", ctx.t("preflightResults.bouncedDirty"));
      assert.ok(!(await cardTones(ctx)).includes("scanning"));

      ctx.gate.resolve();
      await untilAllPassed(ctx);
      await assertSamePage(ctx);
    },
  },

  {
    name: "one column that keeps its shape in every state, with no sideways scroll",
    width: 1920,
    height: 1080,
    setup(ctx) {
      ctx.onScan((token) =>
        result(
          token,
          verdicts({
            meeting: blocked("meeting", ["Zoom.exe"]),
            screen: unverified("screen"),
          })
        )
      );
      ctx.onScan(passScan);
    },
    async run(ctx) {
      const shape = () =>
        ctx.eval(`(() => {
          const rects = [...document.querySelectorAll(".sc-card")].map((c) => c.getBoundingClientRect());
          return {
            lefts: [...new Set(rects.map((r) => Math.round(r.left)))],
            widths: [...new Set(rects.map((r) => Math.round(r.width)))],
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            panelWidth: Math.round(document.querySelector(".sc-panel").getBoundingClientRect().width),
          };
        })()`);

      await ctx.until(
        "document.getElementById('card-meeting').classList.contains('sc-card--fail')",
        "failing scan"
      );
      const failing = await shape();
      assert.strictEqual(failing.lefts.length, 1, "cards share one left edge");
      assert.strictEqual(failing.widths.length, 1, "cards share one width");
      assert.strictEqual(failing.overflow, false);
      assert.ok(failing.panelWidth < 1920 * 0.6, `panel stretched to ${failing.panelWidth}px`);

      await ctx.click("#btn-rescan");
      await untilAllPassed(ctx);
      const passing = await shape();
      assert.deepStrictEqual(passing.lefts, failing.lefts);
      assert.deepStrictEqual(passing.widths, failing.widths);
      assert.strictEqual(passing.overflow, false);
    },
  },

  {
    name: "?reason=stale explains the fresh scan",
    query: { reason: "stale" },
    setup(ctx) {
      ctx.gate = deferred();
      ctx.onScan(async (token) => {
        await ctx.gate.promise;
        return passScan(token);
      });
    },
    async run(ctx) {
      await ctx.untilText("#final-status", ctx.t("preflightResults.bouncedStale"));
      ctx.gate.resolve();
      await untilAllPassed(ctx);
    },
  },

  {
    name: "agent threats show severity, hints and Close where there's a pid",
    setup(ctx) {
      ctx.handle("killThreatProcess", (pid, name) => ({
        processName: name,
        success: true,
        outcome: "closed",
        pid,
      }));
      ctx.onScan((token) =>
        result(
          token,
          verdicts({
            agent: threats([
              {
                type: "ai_cheating_tool",
                severity: "CRITICAL",
                detail: "overlay",
                process: "C:\\Users\\alice\\AppData\\cluely.exe",
                pid: 77,
              },
              { type: "suspicious_network", severity: "MEDIUM", detail: "conn" },
              { type: "remote_session", severity: "HIGH", detail: "rdp" },
              { type: "virtual_machine", severity: "HIGH", detail: "vm" },
              {
                type: "renamed_blocked_app",
                severity: "HIGH",
                detail: "renamed",
                process: "notes.exe",
                pid: 4242,
                original: "zoom.exe",
              },
            ]),
          })
        )
      );
    },
    async run(ctx) {
      await ctx.until("document.querySelectorAll('#actions-agent .sc-kill-row').length === 5");
      const rows =
        await ctx.eval(`[...document.querySelectorAll('#actions-agent .sc-kill-row')].map((r) => ({
        name: r.querySelector('.sc-kill-name').textContent,
        sub: r.querySelector('.sc-kill-process').textContent,
        badge: r.querySelector('.sc-threat-badge').textContent,
        strong: r.querySelector('.sc-threat-badge').classList.contains('sc-threat-badge--strong'),
        hint: r.querySelector('.sc-threat-hint')?.textContent ?? null,
        close: !!r.querySelector('.sc-kill-btn'),
      }))`);
      const t = (k) => ctx.t(`preflightResults.${k}`);
      assert.deepStrictEqual(rows, [
        {
          name: t("threatAiTool"),
          sub: "cluely.exe",
          badge: t("severityCritical"),
          strong: true,
          hint: null,
          close: true,
        },
        {
          name: t("threatNetwork"),
          sub: "",
          badge: t("severityMedium"),
          strong: false,
          hint: null,
          close: false,
        },
        {
          name: t("threatRemoteSession"),
          sub: "",
          badge: t("severityHigh"),
          strong: true,
          hint: t("threatRemoteSessionHint"),
          close: false,
        },
        {
          name: t("threatVirtualMachine"),
          sub: "",
          badge: t("severityHigh"),
          strong: true,
          hint: t("threatVirtualMachineHint"),
          close: false,
        },
        {
          name: t("threatRenamedApp"),
          sub: "notes.exe",
          badge: t("severityHigh"),
          strong: true,
          hint: null,
          close: true,
        },
      ]);
      assert.strictEqual(await ctx.eval("document.body.innerHTML.includes('alice')"), false);
      assert.strictEqual(
        await ctx.text("#desc-agent"),
        await pageT(ctx, "preflightResults.agentThreatsDetected", {
          n: 5,
          rescan: ctx.t("preflight.rescan"),
        })
      );

      const btn = "#actions-agent .sc-kill-row[data-pid='4242'] .sc-kill-btn";
      await openDialogFrom(ctx, btn);
      assert.strictEqual(await ctx.text("#kill-dialog-list"), "notes.exe");
      await ctx.click("#kill-dialog-confirm");
      const [kill] = await ctx.untilCalls("killThreatProcess", 1);
      assert.deepStrictEqual(kill.args, [4242, "notes.exe"]);
      await ctx.untilText(btn, ctx.t("preflightResults.closed"));
      assert.strictEqual(ctx.callsTo("killProcess").length, 0);
    },
  },

  {
    name: "Arabic lays the page out right-to-left with translated threat copy",
    locale: "ar",
    setup(ctx) {
      ctx.onScan((token) =>
        result(
          token,
          verdicts({
            agent: threats([{ type: "remote_session", severity: "HIGH", detail: "rdp" }]),
          })
        )
      );
    },
    async run(ctx) {
      await ctx.until("document.querySelectorAll('#actions-agent .sc-kill-row').length === 1");
      assert.strictEqual(await ctx.eval("document.documentElement.dir"), "rtl");
      assert.strictEqual(await ctx.eval("document.documentElement.lang"), "ar");
      assert.strictEqual(await ctx.text(".sc-intro__title"), ctx.t("preflight.title"));
      assert.strictEqual(await ctx.text("#btn-rescan"), ctx.t("preflight.rescan"));
      assert.strictEqual(
        await ctx.text("#actions-agent .sc-kill-name"),
        ctx.t("preflightResults.threatRemoteSession")
      );
      assert.strictEqual(
        await ctx.text("#actions-agent .sc-threat-hint"),
        ctx.t("preflightResults.threatRemoteSessionHint")
      );
      assert.notStrictEqual(
        ctx.t("preflightResults.threatRemoteSessionHint"),
        ctx.en.preflightResults.threatRemoteSessionHint
      );
    },
  },

  {
    name: "the fake bridge matches preload.js and the page stays offline",
    setup(ctx) {
      ctx.onScan(passScan);
    },
    async run(ctx) {
      await untilAllPassed(ctx);
      const source = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
      const block = source.slice(source.indexOf('exposeInMainWorld("electronAPI"'));
      const expected = [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort();
      const actual = (await ctx.eval("Object.keys(window.electronAPI)")).sort();
      assert.deepStrictEqual(actual, expected);

      assert.ok(ctx.requests.some((u) => u.endsWith("/assets/preflight.html")));
      assert.ok(ctx.requests.some((u) => u.endsWith("/src/renderer/preflight.js")));
      assert.ok(ctx.requests.some((u) => u.endsWith("/assets/css/preflight.css")));
    },
  },
];

module.exports = { scenarios };
