"use strict";

// The violation modal (src/renderer/securityGuard.js) on the setup pages after
// the security check: permissions, identity verification and role selection.

const assert = require("node:assert");
const { delay, deferred, pageT } = require("./util");

const DIALOG = "#security-guard";
const CONFIRM = "#security-guard-confirm";

function app(process, name, pid) {
  return pid ? { process, name, pid } : { process, name };
}

function issue(category, code, apps = [], extra = {}) {
  return { category, code, apps, closable: apps.length > 0, ...extra };
}

function blocked(...issues) {
  return { status: "blocked", issues };
}

const ZOOM = app("Zoom.exe", "Zoom");
const TEAMS = app("Teams.exe", "Microsoft Teams");
const CHROME = app("chrome.exe", "Google Chrome");
const CLUELY = app("cluely.exe", "Cluely");
const DISPLAYS = issue("hdmi", "external_display", [], { count: 2 });

const sel = (s) => JSON.stringify(s);
const appRow = (process) => `#sg-issues .sg-app[data-process="${process}"]`;
const closeBtn = (process) => `${appRow(process)} .sg-app__close`;

function isOpen(ctx, dialog = DIALOG) {
  return ctx.q(dialog, "el.open").then((open) => open === true);
}

function untilOpen(ctx, dialog = DIALOG) {
  return ctx.until(`!!document.querySelector(${sel(dialog)})?.open`, `${dialog} to open`);
}

function untilClosed(ctx, dialog = DIALOG) {
  return ctx.until(`!document.querySelector(${sel(dialog)})?.open`, `${dialog} to close`, 4000);
}

function activeId(ctx) {
  return ctx.eval("document.activeElement?.id || null");
}

/** The focused app row's process, when focus is on one of its buttons. */
function activeApp(ctx) {
  return ctx.eval("document.activeElement?.closest('.sg-app')?.dataset.process ?? null");
}

/** What the modal lists, issue by issue. */
function issueRows(ctx) {
  return ctx.eval(`[...document.querySelectorAll("#sg-issues > .sg-issue")].map((li) => {
    const hint = li.querySelector(".sg-issue__hint");
    return {
      key: li.dataset.key,
      title: li.querySelector(".sg-issue__title").textContent,
      hint: hint.hidden ? null : hint.textContent,
      apps: [...li.querySelectorAll(".sg-app")].map((a) => ({
        name: a.querySelector(".sg-app__name").textContent,
        process: a.dataset.process,
        close: a.querySelector(".sg-app__close")?.textContent ?? null,
      })),
    };
  })`);
}

function row(ctx, key, title, apps, hint = null) {
  const close = ctx.t("preflightResults.close");
  return { key, title, hint, apps: apps.map((a) => ({ name: a.name, process: a.process, close })) };
}

async function assertHead(ctx, kind) {
  const cap = kind[0].toUpperCase() + kind.slice(1);
  assert.strictEqual(await ctx.text("#sg-title"), ctx.t(`securityGuard.title${cap}`));
  assert.strictEqual(await ctx.text("#sg-desc"), ctx.t(`securityGuard.desc${cap}`));
}

async function assertConfirm(ctx, { title, body, names, ok, cancel }) {
  assert.strictEqual(await ctx.text("#sg-confirm-title"), title);
  assert.strictEqual(await ctx.text("#sg-confirm-body"), body);
  if (names) {
    assert.deepStrictEqual(
      await ctx.eval(
        "[...document.querySelectorAll('#sg-confirm-list li')].map((li) => li.textContent)"
      ),
      names
    );
  } else {
    assert.strictEqual(await ctx.isHidden("#sg-confirm-list"), true);
  }
  assert.strictEqual(await ctx.text("#sg-confirm-ok"), ok);
  assert.strictEqual(await ctx.text("#sg-confirm-cancel"), cancel);
  assert.strictEqual(await activeId(ctx), "sg-confirm-cancel", "confirm opens on Cancel");
}

async function killConfirmCopy(ctx, count) {
  return {
    title: await pageT(ctx, "preflightResults.killConfirmTitle", { count }),
    body: await pageT(ctx, "preflightResults.killConfirmBody", { count }),
    ok: await pageT(ctx, "preflightResults.killConfirmAction", { count }),
    cancel: ctx.t("preflightResults.killConfirmCancel"),
  };
}

/** Closes the modal behind the guard's back and clicks `button` in the same task. */
function clickPastClosedModal(ctx, button) {
  return ctx.eval(`(() => {
    const dlg = document.getElementById("security-guard");
    dlg.close();
    document.querySelector(${sel(button)}).click();
    return dlg.open;
  })()`);
}

async function grantAll(ctx) {
  for (const perm of ["camera", "mic", "screen"]) {
    await ctx.click(`#btn-${perm}`);
    await ctx.until(
      `document.getElementById("card-${perm}").classList.contains("perm-card--granted")`,
      `${perm} to be granted`
    );
  }
  assert.strictEqual(await ctx.q("#btn-start", "el.disabled"), false);
}

/** Records a voice take long enough to keep and waits for its review step. */
async function recordTake(ctx) {
  await ctx.click("#btn-start-recording");
  await ctx.until("!document.getElementById('voice-cta-recording').hidden", "recording to start");
  await ctx.until(
    "!document.getElementById('btn-stop-recording').disabled",
    "Stop to unlock",
    6000
  );
  await ctx.click("#btn-stop-recording");
  await ctx.until("!document.getElementById('voice-cta-reviewing').hidden", "the take to review");
}

async function toSkills(ctx) {
  await ctx.until("!document.getElementById('confirm-content').hidden", "the assigned role");
  assert.strictEqual(await ctx.text("#confirm-role-name"), "Frontend Developer");
  await ctx.click("#btn-yes");
  const [submit] = await ctx.untilCalls("submitRole", 1);
  assert.deepStrictEqual(submit.args, ["Frontend Developer"]);
  await ctx.until("!document.getElementById('panel-skills').hidden", "the skills step");
}

const bootScenarios = ["permissions", "identity-verification", "role-selection"].map((page) => ({
  name: `guard: ${page} boots clear with no modal`,
  page,
  async run(ctx) {
    await ctx.untilCalls("getSecurityGuardStatus", 1);
    assert.strictEqual(ctx.callsTo("onSecurityGuardStatus").length, 1);
    await delay(200);
    assert.strictEqual(await isOpen(ctx), false);
    assert.strictEqual(await ctx.eval("window.securityGuard.isBlocked()"), false);
    assert.ok(ctx.requests.some((u) => u.endsWith("/src/renderer/securityGuard.js")));
    assert.ok(ctx.requests.some((u) => u.endsWith("/assets/css/security-guard.css")));
  },
}));

const scenarios = [
  ...bootScenarios,

  {
    name: "guard: a blocked push opens the modal with its apps; Escape and Tab stay inside",
    page: "permissions",
    async run(ctx) {
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM, TEAMS]), DISPLAYS));
      await untilOpen(ctx);
      assert.strictEqual(await ctx.q(DIALOG, "el.getAttribute('role')"), "alertdialog");
      assert.strictEqual(await ctx.q(DIALOG, "el.getAttribute('aria-modal')"), "true");
      await assertHead(ctx, "fix");
      assert.deepStrictEqual(await issueRows(ctx), [
        row(ctx, "meeting|blocked_app", ctx.t("preflight.meetingTitle"), [ZOOM, TEAMS]),
        row(
          ctx,
          "hdmi|external_display",
          ctx.t("preflight.hdmiTitle"),
          [],
          await pageT(ctx, "securityGuard.hintDisplayCount", { count: 2 })
        ),
      ]);
      assert.strictEqual(
        await ctx.q(closeBtn("Teams.exe"), "el.getAttribute('aria-label')"),
        ctx.t("preflightResults.closeApp", { name: "Microsoft Teams" })
      );
      assert.strictEqual(
        await ctx.text("#sg-close-all"),
        await pageT(ctx, "preflightResults.closeAll", { count: 2 })
      );
      assert.strictEqual(await ctx.text("#sg-recheck"), ctx.t("securityGuard.checkAgain"));
      assert.strictEqual(await ctx.text("#sg-leave"), ctx.t("securityGuard.leave"));
      assert.strictEqual(await activeId(ctx), "sg-title");

      for (let i = 1; i <= 3; i += 1) {
        await ctx.press("Escape");
        await delay(100);
        assert.strictEqual(await isOpen(ctx), true, `Escape #${i} closed the modal`);
      }

      const stops = [];
      for (let i = 0; i < 6; i += 1) {
        await ctx.press("Tab");
        stops.push((await activeApp(ctx)) || (await activeId(ctx)));
      }
      assert.deepStrictEqual(stops, [
        "Zoom.exe",
        "Teams.exe",
        "sg-close-all",
        "sg-recheck",
        "sg-leave",
        "Zoom.exe",
      ]);
      await ctx.press("Tab", ["shift"]);
      assert.strictEqual(await activeId(ctx), "sg-leave");
      assert.strictEqual(await isOpen(ctx), true);
    },
  },

  {
    name: "guard: a refused Continue opens the modal from main's answer and restores the button",
    page: "permissions",
    setup(ctx) {
      ctx.handle("loadIdentityVerification", () => ({
        ok: false,
        reason: "blocked",
        guard: ctx.setGuard(blocked(issue("browser", "blocked_app", [CHROME]))),
      }));
    },
    async run(ctx) {
      await grantAll(ctx);
      await ctx.click("#btn-start");
      await ctx.untilCalls("loadIdentityVerification", 1);
      await untilOpen(ctx);
      await assertHead(ctx, "close");
      assert.deepStrictEqual(await issueRows(ctx), [
        row(ctx, "browser|blocked_app", ctx.t("preflight.browserTitle"), [CHROME]),
      ]);
      assert.strictEqual(await ctx.q("#btn-start", "el.disabled"), false);
      assert.strictEqual(await ctx.text("#btn-start-label"), ctx.t("common.continue"));
      assert.strictEqual(await ctx.q("#btn-start-icon", "el.classList.contains('spin')"), false);
      assert.strictEqual(await ctx.text("#perm-note"), ctx.t("perm.allGranted"));

      assert.strictEqual(await clickPastClosedModal(ctx, "#btn-start"), true, "Continue reopens");
      await delay(300);
      assert.strictEqual(ctx.callsTo("loadIdentityVerification").length, 1);
      assert.strictEqual(await isOpen(ctx), true);
    },
  },

  {
    name: "guard: a newer push updates the rows in place and an older one is ignored",
    page: "permissions",
    async run(ctx) {
      ctx.guard({ ...blocked(issue("meeting", "blocked_app", [ZOOM])), seq: 5 });
      await untilOpen(ctx);
      await assertHead(ctx, "close");
      assert.strictEqual(await ctx.isHidden("#sg-close-all"), true, "one app needs no Close all");
      await ctx.q(appRow("Zoom.exe"), "(el.__e2eKept = true)");
      await ctx.q(closeBtn("Zoom.exe"), "(el.focus(), true)");

      ctx.guard({
        ...blocked(
          issue("meeting", "blocked_app", [ZOOM, TEAMS]),
          issue("ai", "ai_tool", [CLUELY])
        ),
        seq: 6,
      });
      await ctx.until("document.querySelectorAll('#sg-issues .sg-app').length === 3", "new apps");
      const rows = await issueRows(ctx);
      assert.deepStrictEqual(rows, [
        row(ctx, "meeting|blocked_app", ctx.t("preflight.meetingTitle"), [ZOOM, TEAMS]),
        row(ctx, "ai|ai_tool", ctx.t("preflight.aiTitle"), [CLUELY]),
      ]);
      assert.strictEqual(await ctx.q(appRow("Zoom.exe"), "el.__e2eKept"), true, "row rebuilt");
      assert.strictEqual(await activeApp(ctx), "Zoom.exe", "focus lost on update");
      assert.strictEqual(
        await ctx.text("#sg-close-all"),
        await pageT(ctx, "preflightResults.closeAll", { count: 3 })
      );

      ctx.guard({ ...blocked(issue("browser", "blocked_app", [CHROME])), seq: 4 });
      await delay(300);
      assert.deepStrictEqual(await issueRows(ctx), rows);
      assert.strictEqual(await ctx.eval("window.securityGuard.getState().seq"), 6);
    },
  },

  {
    name: "guard: Close asks first, closes the app, checks again and says why a close failed",
    page: "permissions",
    setup(ctx) {
      ctx.handle("killProcess", (name) =>
        ctx.callsTo("killProcess").length === 1
          ? { processName: name, success: false, outcome: "spawn-error" }
          : { processName: name, success: true, outcome: "closed" }
      );
      ctx.handle("recheckSecurityGuard", () =>
        ctx.setGuard(
          ctx.callsTo("killProcess").length < 2
            ? blocked(issue("meeting", "blocked_app", [ZOOM]))
            : { status: "clear" }
        )
      );
    },
    async run(ctx) {
      const btn = closeBtn("Zoom.exe");
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM])));
      await untilOpen(ctx);
      const copy = await killConfirmCopy(ctx, 1);

      await ctx.click(btn);
      await untilOpen(ctx, CONFIRM);
      await assertConfirm(ctx, { ...copy, names: ["Zoom"] });
      await ctx.click("#sg-confirm-cancel");
      await untilClosed(ctx, CONFIRM);
      await delay(150);
      assert.strictEqual(ctx.callsTo("killProcess").length, 0);
      assert.strictEqual(await isOpen(ctx), true);
      assert.strictEqual(await activeApp(ctx), "Zoom.exe", "Cancel gives focus back to Close");

      await ctx.click(btn);
      await untilOpen(ctx, CONFIRM);
      await ctx.click("#sg-confirm-ok");
      const [kill] = await ctx.untilCalls("killProcess", 1);
      assert.deepStrictEqual(kill.args, ["Zoom.exe"]);
      await ctx.untilCalls("recheckSecurityGuard", 1);
      await ctx.until(
        `(() => { const b = document.querySelector(${sel(btn)});
          return b?.classList.contains("sg-app__close--failed") && !b.disabled; })()`,
        "a failed Close"
      );
      assert.strictEqual(await ctx.text(btn), ctx.t("preflightResults.closeFailedManual"));
      const hint = ctx.t("preflightResults.killGenericHint", {
        name: "Zoom",
        rescan: ctx.t("securityGuard.checkAgain"),
      });
      assert.strictEqual(await ctx.text(`${appRow("Zoom.exe")} .sg-app__hint`), hint);
      await ctx.untilText("#sg-announcer", hint);

      // Confirmed once is enough for the same app.
      await ctx.click(btn);
      await ctx.untilCalls("killProcess", 2);
      assert.strictEqual(await isOpen(ctx, CONFIRM), false);
      await ctx.untilCalls("recheckSecurityGuard", 2);
      await ctx.untilText("#sg-title", ctx.t("securityGuard.titleClear"));
      await untilClosed(ctx);
    },
  },

  {
    name: "guard: Close all closes every app it can in one go",
    page: "permissions",
    setup(ctx) {
      ctx.handle("killAllProcesses", (names) =>
        names.map((processName) => ({ processName, success: true, outcome: "closed" }))
      );
      ctx.handle("killThreatProcess", (pid, processName) => ({
        processName,
        success: true,
        outcome: "closed",
        pid,
      }));
      ctx.handle("recheckSecurityGuard", () => ctx.setGuard(blocked(DISPLAYS)));
    },
    async run(ctx) {
      ctx.guard(
        blocked(
          issue("meeting", "blocked_app", [ZOOM, TEAMS]),
          issue("browser", "blocked_app", [CHROME]),
          issue("agent", "ai_tool", [app("C:\\Users\\alice\\AppData\\cluely.exe", "Cluely", 77)]),
          DISPLAYS
        )
      );
      await untilOpen(ctx);
      await assertHead(ctx, "fix");
      assert.strictEqual(
        await ctx.text("#sg-issues .sg-issue[data-code='ai_tool'] .sg-issue__title"),
        ctx.t("preflightResults.threatAiTool")
      );
      assert.strictEqual(await ctx.q(DIALOG, "el.innerHTML.includes('alice')"), false);
      assert.strictEqual(
        await ctx.text("#sg-close-all"),
        await pageT(ctx, "preflightResults.closeAll", { count: 4 })
      );

      await ctx.click("#sg-close-all");
      await untilOpen(ctx, CONFIRM);
      await assertConfirm(ctx, {
        ...(await killConfirmCopy(ctx, 4)),
        names: ["Zoom", "Microsoft Teams", "Google Chrome", "Cluely"],
      });
      await ctx.click("#sg-confirm-ok");
      const [all] = await ctx.untilCalls("killAllProcesses", 1);
      assert.deepStrictEqual(all.args, [["Zoom.exe", "Teams.exe", "chrome.exe"]]);
      const [threat] = await ctx.untilCalls("killThreatProcess", 1);
      assert.deepStrictEqual(threat.args, [77, "cluely.exe"]);
      assert.strictEqual(ctx.callsTo("killProcess").length, 0);

      await ctx.untilCalls("recheckSecurityGuard", 1);
      await ctx.until("document.querySelectorAll('#sg-issues > .sg-issue').length === 1");
      assert.deepStrictEqual(
        (await issueRows(ctx)).map((r) => r.key),
        ["hdmi|external_display"]
      );
      assert.strictEqual(await ctx.isHidden("#sg-close-all"), true);
      await ctx.untilText("#sg-announcer", ctx.t("preflightResults.allClosedRescanning"));
      assert.strictEqual(await isOpen(ctx), true);
    },
  },

  {
    name: "guard: a clear push shows All clear, then closes and gives focus back",
    page: "permissions",
    async run(ctx) {
      await ctx.q("#btn-mic", "(el.focus(), true)");
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM])));
      await untilOpen(ctx);
      assert.strictEqual(await activeId(ctx), "sg-title");

      ctx.guard({ status: "clear" });
      await ctx.untilText("#sg-title", ctx.t("securityGuard.titleClear"));
      const cleared = Date.now();
      assert.strictEqual(await ctx.hasClass(DIALOG, "sg-dialog--clear"), true);
      assert.strictEqual(await ctx.text("#sg-desc"), ctx.t("securityGuard.descClear"));
      assert.strictEqual(await ctx.isHidden("#sg-issues"), true);
      assert.strictEqual(await ctx.isHidden("#sg-actions"), true);
      assert.strictEqual(await isOpen(ctx), true, "All clear shows before closing");
      await ctx.untilText("#sg-announcer", ctx.t("securityGuard.titleClear"));
      await untilClosed(ctx);
      const held = Date.now() - cleared;
      assert.ok(held >= 700, `All clear only showed for ${held}ms`);
      assert.strictEqual(await activeId(ctx), "btn-mic");
      assert.strictEqual(await ctx.eval("window.securityGuard.isBlocked()"), false);

      // Something new during All clear keeps the modal up.
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM])));
      await untilOpen(ctx);
      ctx.guard({ status: "clear" });
      await ctx.untilText("#sg-title", ctx.t("securityGuard.titleClear"));
      await delay(300);
      ctx.guard(blocked(issue("browser", "blocked_app", [CHROME])));
      await ctx.untilText("#sg-title", ctx.t("securityGuard.titleClose"));
      await delay(1200);
      assert.strictEqual(await isOpen(ctx), true);
      assert.strictEqual(await ctx.hasClass(DIALOG, "sg-dialog--clear"), false);
    },
  },

  {
    name: "guard: the unverified modal says so and Check again runs a fresh check",
    page: "permissions",
    setup(ctx) {
      ctx.gate = deferred();
      ctx.handle("recheckSecurityGuard", async () => {
        await ctx.gate.promise;
        return ctx.setGuard({ status: "clear" });
      });
    },
    async run(ctx) {
      ctx.guard({ status: "unverified", issues: [issue("agent", "agent_unreachable")] });
      await untilOpen(ctx);
      await assertHead(ctx, "unverified");
      assert.ok(await ctx.hasClass("#sg-icon", "sg-head__icon--unverified"));
      assert.strictEqual(await ctx.text("#sg-recheck"), ctx.t("securityGuard.checkAgain"));
      assert.strictEqual(await ctx.isHidden("#sg-close-all"), true);
      assert.strictEqual(await ctx.isHidden("#sg-issues"), true);
      assert.strictEqual(await ctx.q(DIALOG, "el.getAttribute('aria-busy')"), "false");

      await ctx.click("#sg-recheck");
      await ctx.untilCalls("recheckSecurityGuard", 1);
      await ctx.until(
        `document.querySelector(${sel(DIALOG)}).getAttribute("aria-busy") === "true"`
      );
      assert.strictEqual(await ctx.text("#sg-status"), ctx.t("securityGuard.checking"));
      assert.strictEqual(await ctx.q("#sg-recheck", "el.disabled"), true);
      assert.strictEqual(await ctx.q("#sg-leave", "el.disabled"), false, "Leave stays usable");

      ctx.gate.resolve();
      await ctx.untilText("#sg-title", ctx.t("securityGuard.titleClear"));
      await untilClosed(ctx);
      assert.strictEqual(ctx.callsTo("recheckSecurityGuard").length, 1);
    },
  },

  {
    name: "guard: Leave setup asks first; Stay keeps the modal, Leave goes to the dashboard",
    page: "permissions",
    async run(ctx) {
      ctx.guard(blocked(DISPLAYS));
      await untilOpen(ctx);
      const copy = {
        title: ctx.t("securityGuard.leaveTitle"),
        body: ctx.t("securityGuard.leaveBody"),
        ok: ctx.t("securityGuard.leave"),
        cancel: ctx.t("securityGuard.stay"),
      };

      await ctx.click("#sg-leave");
      await untilOpen(ctx, CONFIRM);
      await assertConfirm(ctx, copy);
      await ctx.click("#sg-confirm-cancel");
      await untilClosed(ctx, CONFIRM);
      await delay(150);
      assert.strictEqual(await isOpen(ctx), true);
      assert.strictEqual(await activeId(ctx), "sg-leave");

      // Escape backs out of the confirm step only.
      await ctx.click("#sg-leave");
      await untilOpen(ctx, CONFIRM);
      await ctx.press("Escape");
      await untilClosed(ctx, CONFIRM);
      await delay(150);
      assert.strictEqual(await isOpen(ctx), true);
      assert.strictEqual(ctx.callsTo("loadDashboard").length, 0);

      await ctx.click("#sg-leave");
      await untilOpen(ctx, CONFIRM);
      await ctx.click("#sg-confirm-ok");
      const [leave] = await ctx.untilCalls("loadDashboard", 1);
      assert.deepStrictEqual(leave.args, []);
    },
  },

  {
    name: "guard: a page loaded while blocked opens the modal straight away",
    page: "identity-verification",
    setup(ctx) {
      ctx.setGuard(blocked(issue("screen", "blocked_app", [app("obs64.exe", "OBS Studio")])));
    },
    async run(ctx) {
      assert.strictEqual(await isOpen(ctx), true, "modal open on first paint");
      await assertHead(ctx, "close");
      assert.deepStrictEqual(await issueRows(ctx), [
        row(ctx, "screen|blocked_app", ctx.t("preflight.screenTitle"), [
          app("obs64.exe", "OBS Studio"),
        ]),
      ]);
      await ctx.until("document.activeElement?.id === 'sg-title'", "focus on the modal title");
      assert.strictEqual(ctx.callsTo("getSecurityGuardStatus").length, 1);
    },
  },

  {
    name: "guard: a block mid-recording throws the take away and asks for a new one once clear",
    page: "identity-verification",
    offscreen: true,
    async run(ctx) {
      await ctx.click("#btn-start-recording");
      await ctx.until("!document.getElementById('voice-cta-recording').hidden", "recording");
      await delay(600);
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM])));
      await untilOpen(ctx);
      await ctx.until(
        "!document.getElementById('voice-cta-idle').hidden",
        "the take to be dropped"
      );
      assert.strictEqual(await ctx.isHidden("#voice-cta-reviewing"), true);
      assert.strictEqual(await ctx.isHidden("#iv-waveform"), true);
      assert.strictEqual(await ctx.isHidden("#iv-error"), true, "no note while still blocked");

      assert.strictEqual(await clickPastClosedModal(ctx, "#btn-start-recording"), true);
      await delay(300);
      assert.strictEqual(
        await ctx.isHidden("#voice-cta-recording"),
        true,
        "recorded while blocked"
      );

      ctx.guard({ status: "clear" });
      await untilClosed(ctx);
      await ctx.untilText("#iv-error-text", ctx.t("securityGuard.recordAgain"));
      assert.strictEqual(await ctx.isHidden("#iv-error"), false);
      assert.strictEqual(ctx.callsTo("submitVoiceSample").length, 0);

      await recordTake(ctx);
      assert.strictEqual(await ctx.isHidden("#iv-error"), true);
      await ctx.click("#btn-continue-voice");
      const [voice] = await ctx.untilCalls("submitVoiceSample", 1);
      assert.strictEqual(voice.args[2].statementText, ctx.t("attestation.statement"));
    },
  },

  {
    name: "guard: identity Continue saves the photo, then asks main; a refusal opens the modal",
    page: "identity-verification",
    offscreen: true,
    setup(ctx) {
      ctx.handle("loadRoleSelection", () => ({
        ok: false,
        reason: "blocked",
        guard: ctx.setGuard(blocked(issue("ai", "ai_tool", [CLUELY]))),
      }));
    },
    async run(ctx) {
      await recordTake(ctx);
      await ctx.click("#btn-continue-voice");
      await ctx.untilCalls("submitVoiceSample", 1);
      await ctx.until("!document.getElementById('btn-capture').disabled", "the camera", 8000);
      await ctx.click("#btn-capture");
      await ctx.click("#btn-submit-photo");
      const [face] = await ctx.untilCalls("submitFaceVerification", 1);
      await ctx.until("!document.getElementById('btn-begin-interview').hidden", "the result");

      await ctx.click("#btn-begin-interview");
      await ctx.untilCalls("loadRoleSelection", 1);
      await untilOpen(ctx);
      const order = ctx.calls
        .map((c) => c.method)
        .filter((m) => m === "storeCandidatePhoto" || m === "loadRoleSelection");
      assert.deepStrictEqual(order, ["storeCandidatePhoto", "loadRoleSelection"]);
      const [photo] = ctx.callsTo("storeCandidatePhoto");
      assert.match(photo.args[0], /^data:image\/jpeg;base64,/);
      assert.strictEqual(photo.args[0], face.args[0]);

      await assertHead(ctx, "close");
      assert.deepStrictEqual(await issueRows(ctx), [
        row(ctx, "ai|ai_tool", ctx.t("preflight.aiTitle"), [CLUELY]),
      ]);
      assert.strictEqual(await ctx.q("#btn-begin-interview", "el.disabled"), false);
      assert.strictEqual(await ctx.text("#btn-begin-interview"), ctx.t("common.continue"));
      assert.strictEqual(await ctx.isHidden("#iv-error"), true);

      assert.strictEqual(await clickPastClosedModal(ctx, "#btn-begin-interview"), true);
      await delay(300);
      assert.strictEqual(ctx.callsTo("storeCandidatePhoto").length, 1);
      assert.strictEqual(ctx.callsTo("loadRoleSelection").length, 1);
    },
  },

  {
    name: "guard: Start Interview goes ahead without the modal when main allows it",
    page: "role-selection",
    async run(ctx) {
      await toSkills(ctx);
      await ctx.click("#btn-start-interview");
      const [call] = await ctx.untilCalls("proceedToInterview", 1);
      assert.deepStrictEqual(call.args, [{ is_custom_role: false }]);
      await delay(300);
      assert.strictEqual(await isOpen(ctx), false);
      assert.strictEqual(await ctx.isHidden("#rs-error"), true);
      assert.strictEqual(
        await ctx.q("#btn-start-interview", "el.disabled"),
        true,
        "waits for main"
      );
    },
  },

  {
    name: "guard: a Start Interview refused as unverified opens the unverified modal",
    page: "role-selection",
    setup(ctx) {
      ctx.handle("proceedToInterview", () =>
        ctx.callsTo("proceedToInterview").length === 1
          ? {
              ok: false,
              reason: "unverified",
              guard: ctx.setGuard({
                status: "unverified",
                issues: [issue("screen", "check_unverified")],
              }),
            }
          : { ok: true }
      );
      ctx.handle("recheckSecurityGuard", () => ctx.setGuard({ status: "clear" }));
    },
    async run(ctx) {
      await toSkills(ctx);
      await ctx.q("#btn-start-interview", "(el.focus(), true)");
      await ctx.click("#btn-start-interview");
      await ctx.untilCalls("proceedToInterview", 1);
      await untilOpen(ctx);
      await assertHead(ctx, "unverified");
      assert.strictEqual(await ctx.text("#sg-recheck"), ctx.t("securityGuard.checkAgain"));
      assert.strictEqual(await ctx.q("#btn-start-interview", "el.disabled"), false);
      assert.strictEqual(await ctx.text("#btn-start-interview"), ctx.t("role.startInterview"));
      assert.strictEqual(await ctx.isHidden("#rs-error"), true);

      await ctx.click("#sg-recheck");
      await untilClosed(ctx);
      assert.strictEqual(await activeId(ctx), "btn-start-interview");
      await ctx.click("#btn-start-interview");
      await ctx.untilCalls("proceedToInterview", 2);
    },
  },

  {
    name: "guard: the modal fits a 375x812 window with no sideways scroll",
    // The permissions page's own card row is wider than a phone; this one isn't.
    page: "identity-verification",
    width: 375,
    height: 812,
    async run(ctx) {
      assert.deepStrictEqual(await ctx.eval("[innerWidth, innerHeight]"), [375, 812]);
      ctx.guard(
        blocked(
          issue("meeting", "blocked_app", [
            ZOOM,
            TEAMS,
            app("slack.exe", "Slack"),
            app("Discord.exe", "Discord"),
            app("CiscoCollabHost.exe", "Cisco Webex Meetings Desktop Collaboration Host"),
          ]),
          issue("agent", "renamed_app", [
            app("averyveryveryverylongprocessnamewithoutanyspaces.exe", "Renamed", 4242),
          ]),
          DISPLAYS,
          issue("agent", "remote_session")
        )
      );
      await untilOpen(ctx);
      assert.strictEqual(
        await ctx.text("#sg-issues .sg-more"),
        await pageT(ctx, "securityGuard.more", { count: 1 })
      );

      const fits = (dialog) =>
        ctx.eval(`(() => {
          const dlg = document.querySelector(${sel(dialog)});
          dlg.getAnimations().forEach((a) => a.finish());
          const box = dlg.getBoundingClientRect();
          const root = document.documentElement;
          const sticking = [...dlg.querySelectorAll("*")]
            .filter((el) => !el.closest(".sg-sr-only") && el.getClientRects().length > 0)
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.left < box.left - 0.5 || r.right > box.right + 0.5;
            })
            .map((el) => el.id || el.className);
          return {
            inViewport:
              box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
            pageScrollsSideways: root.scrollWidth > root.clientWidth,
            dialogScrollsSideways: dlg.scrollWidth > dlg.clientWidth,
            sticking,
          };
        })()`);
      const expected = {
        inViewport: true,
        pageScrollsSideways: false,
        dialogScrollsSideways: false,
        sticking: [],
      };
      assert.deepStrictEqual(await fits(DIALOG), expected);

      await ctx.click("#sg-close-all");
      await untilOpen(ctx, CONFIRM);
      assert.deepStrictEqual(await fits(CONFIRM), expected);
    },
  },

  {
    name: "guard: Arabic lays the modal out right-to-left",
    page: "permissions",
    locale: "ar",
    async run(ctx) {
      ctx.guard(blocked(issue("meeting", "blocked_app", [ZOOM])));
      await untilOpen(ctx);
      assert.strictEqual(await ctx.eval("document.documentElement.dir"), "rtl");
      assert.strictEqual(await ctx.q(DIALOG, "getComputedStyle(el).direction"), "rtl");
      await assertHead(ctx, "close");
      assert.strictEqual(
        await ctx.text("#sg-issues .sg-issue__title"),
        ctx.t("preflight.meetingTitle")
      );
      assert.notStrictEqual(ctx.t("preflight.meetingTitle"), ctx.en.preflight.meetingTitle);
      assert.strictEqual(await ctx.text("#sg-recheck"), ctx.t("securityGuard.checkAgain"));

      const mirrored = await ctx.eval(`(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          iconRightOfTitle: box("#sg-icon").left > box("#sg-title").left,
          closeLeftOfName: box(".sg-app__close").right <= box(".sg-app__name").left,
        };
      })()`);
      assert.deepStrictEqual(mirrored, { iconRightOfTitle: true, closeLeftOfName: true });
    },
  },
];

module.exports = { scenarios };
