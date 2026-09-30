"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  STEPS,
  STEP_IDS,
  GUARDED_STEP_IDS,
  languageStepShown,
  visibleSteps,
  stepPosition,
} = require("../src/shared/flowSteps");

const ASSETS = path.join(__dirname, "../assets");
const en = JSON.parse(fs.readFileSync(path.join(ASSETS, "locales/en.json"), "utf8"));
const lookup = (key) => key.split(".").reduce((node, part) => node?.[part], en);

// The pages between Take interview and the interview, and the step each one is.
const SETUP_PAGES = {
  "language-selection.html": "language",
  "preflight.html": "preflight",
  "permissions.html": "permissions",
  "identity-verification.html": "identity",
  "role-selection.html": "role",
  "interview-rules.html": "rules",
};

test("the setup steps run language, security check, permissions, identity, role, rules", () => {
  assert.deepStrictEqual(STEP_IDS, [
    "language",
    "preflight",
    "permissions",
    "identity",
    "role",
    "rules",
  ]);
  assert.deepStrictEqual(GUARDED_STEP_IDS, ["permissions", "identity", "role", "rules"]);
});

test("the language step counts only when there is more than one language", () => {
  assert.strictEqual(languageStepShown([{ code: "en" }]), false);
  assert.strictEqual(languageStepShown([]), false);
  assert.strictEqual(languageStepShown(undefined), false);
  assert.strictEqual(languageStepShown([{ code: "en" }, { code: "hi" }]), true);
  assert.deepStrictEqual(
    visibleSteps({ languageShown: false }).map((s) => s.id),
    STEP_IDS.filter((id) => id !== "language")
  );
});

test("positions are numbered from the steps actually shown", () => {
  const pos = (id, languageShown) => {
    const p = stepPosition(id, { languageShown });
    return p && `${p.number}/${p.total}`;
  };
  assert.strictEqual(pos("language", true), "1/6");
  assert.strictEqual(pos("identity", true), "4/6");
  assert.strictEqual(pos("preflight", false), "1/5");
  assert.strictEqual(pos("identity", false), "3/5");
  assert.strictEqual(pos("rules", false), "5/5");
  assert.strictEqual(pos("language", false), null);
  assert.strictEqual(pos("dashboard", true), null);
});

test("every step has an English label and the progress line keeps its tokens", () => {
  for (const step of STEPS) {
    assert.strictEqual(lookup(step.labelKey), step.fallback, step.id);
  }
  const progress = lookup("flowSteps.progress");
  for (const token of ["{number}", "{total}", "{name}"]) {
    assert.ok(progress.includes(token), token);
  }
});

test("each setup page shows the indicator for its own step, and loads the order before it", () => {
  for (const [file, step] of Object.entries(SETUP_PAGES)) {
    const html = fs.readFileSync(path.join(ASSETS, file), "utf8");
    const marks = [...html.matchAll(/id="step-indicator"[^>]*data-flow-step="(\w+)"/g)];
    assert.deepStrictEqual(
      marks.map((m) => m[1]),
      [step],
      file
    );
    const order = html.indexOf("src/shared/flowSteps.js");
    const indicator = html.indexOf("src/renderer/stepIndicator.js");
    assert.ok(
      order !== -1 && indicator > order,
      `${file} loads flowSteps.js before stepIndicator.js`
    );
    assert.ok(html.indexOf("js/i18n.js") < indicator, `${file} loads i18n.js first`);
  }
  assert.deepStrictEqual(Object.values(SETUP_PAGES), STEP_IDS);
});

test("no other page claims a setup step", () => {
  for (const file of fs.readdirSync(ASSETS).filter((f) => f.endsWith(".html"))) {
    if (!(file in SETUP_PAGES)) {
      assert.ok(!fs.readFileSync(path.join(ASSETS, file), "utf8").includes("data-flow-step"), file);
    }
  }
});

test("the main process uses the same language rule as the indicator", () => {
  const handlers = fs.readFileSync(path.join(__dirname, "../src/main/ipcHandlers.js"), "utf8");
  assert.match(handlers, /languageStepShown\(localeManager\.getSupportedLocales\(\)\)/);
});
