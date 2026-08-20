"use strict";

/**
 * Guards the i18n render-hook contract (assets/js/i18n.js registerRenderer).
 *
 * Two failure modes this catches, both of which shipped as live bugs before
 * the contract existed:
 *
 *  1. Dual ownership — an element carrying data-i18n whose text is ALSO
 *     written by its page controller. i18n.js's [data-i18n] sweep re-runs on
 *     every locale change and blindly resets textContent, so switching
 *     language reverted live state (a granted permission badge snapped back
 *     to "Required", a step-3 sidebar snapped back to step-1 copy).
 *
 *  2. A page that renders text through tr()/window.t() but never registers a
 *     renderer — its JS-rendered strings stay frozen in the previous language
 *     after a switch, producing a half-translated screen.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const RENDERERS = path.join(ROOT, "src/renderer");

/** Pages are <name>.html + src/renderer/<name>.js. */
function pagePairs() {
  return fs
    .readdirSync(ASSETS)
    .filter((f) => f.endsWith(".html"))
    .map((f) => f.replace(/\.html$/, ""))
    .filter((name) => fs.existsSync(path.join(RENDERERS, `${name}.js`)))
    .map((name) => ({
      name,
      html: fs.readFileSync(path.join(ASSETS, `${name}.html`), "utf8"),
      js: fs.readFileSync(path.join(RENDERERS, `${name}.js`), "utf8"),
    }));
}

/** Elements carrying both an id and a data-i18n key, in either attribute order. */
function idsWithI18nKey(html) {
  const out = new Map();
  for (const m of html.matchAll(/<[^>]*\bid="([\w-]+)"[^>]*\bdata-i18n="([\w.]+)"[^>]*>/g)) {
    out.set(m[1], m[2]);
  }
  for (const m of html.matchAll(/<[^>]*\bdata-i18n="([\w.]+)"[^>]*\bid="([\w-]+)"[^>]*>/g)) {
    out.set(m[2], m[1]);
  }
  return out;
}

/**
 * True if the page's JS looks up this id. Covers both the literal form and the
 * template-literal form (`badge-${perm}`) — the latter is what hid three of the
 * original permissions.js conflicts from a naive grep, so it must stay covered.
 */
function jsLooksUpId(js, id) {
  if (js.includes(`getElementById("${id}")`) || js.includes(`getElementById('${id}')`)) {
    return true;
  }
  for (const m of js.matchAll(/getElementById\(\s*`([^`$]*)\$\{/g)) {
    if (m[1].length > 0 && id.startsWith(m[1])) {
      return true;
    }
  }
  return false;
}

/**
 * Blanks out comments so prose can't be mistaken for code. Without this, a
 * comment merely containing the word "await" trips the ordering check below
 * and the test starts dictating how comments may be worded. Replaces rather
 * than deletes so byte offsets — and therefore ordering — stay meaningful.
 * `://` is left alone so URLs aren't mistaken for line comments.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

for (const { name, html, js } of pagePairs()) {
  test(`${name}: no element is owned by both the [data-i18n] sweep and page JS`, () => {
    const conflicts = [];
    for (const [id, key] of idsWithI18nKey(html)) {
      if (jsLooksUpId(js, id)) {
        conflicts.push(`#${id} (data-i18n="${key}")`);
      }
    }
    assert.deepStrictEqual(
      conflicts,
      [],
      `${name}.html: these elements carry data-i18n but ${name}.js also writes them. ` +
        `Remove the attribute and render them from the page's registerRenderer() ` +
        `callback instead, so a locale change re-translates without reverting state: ` +
        conflicts.join(", ")
    );
  });

  test(`${name}: registers an i18n renderer if it renders any translated text`, () => {
    const rendersText = /\btr\(\s*"/.test(js) || /window\.t\(\s*"/.test(js);
    if (!rendersText) {
      return;
    }
    assert.ok(
      js.includes("registerRenderer"),
      `${name}.js renders text via tr()/window.t() but never calls ` +
        `window.i18n.registerRenderer(). Its strings would stay in the previous ` +
        `language after a locale switch.`
    );
  });

  test(`${name}: registers its renderer before the first await`, () => {
    if (!js.includes("registerRenderer")) {
      return;
    }
    // registerRenderer runs the callback immediately when the bundle already
    // landed, but the initial pre-reveal pass only reaches renderers that
    // registered synchronously — registering after an await paints
    // untranslated text for a frame.
    const handler = js.indexOf('addEventListener("DOMContentLoaded"');
    if (handler === -1) {
      return;
    }
    const body = stripComments(js.slice(handler));
    const register = body.indexOf("registerRenderer");
    const firstAwait = body.search(/\bawait\b/);
    if (firstAwait === -1) {
      return;
    }
    assert.ok(
      register !== -1 && register < firstAwait,
      `${name}.js calls registerRenderer() after its first await inside the ` +
        `DOMContentLoaded handler. Move it above the await so the initial ` +
        `pre-reveal render pass includes this page.`
    );
  });
}

test("i18n.js runs registered renderers before revealing the page", () => {
  const src = fs.readFileSync(path.join(ASSETS, "js/i18n.js"), "utf8");
  const run = src.indexOf("_runRenderers();");
  const reveal = src.indexOf("_reveal();");
  assert.ok(run !== -1 && reveal !== -1, "expected _runRenderers()/_reveal() in i18n.js");
  assert.ok(
    run < reveal,
    "_runRenderers() must precede _reveal() so JS-owned text is translated on first paint"
  );
});

test("i18n.js re-runs renderers on locale change", () => {
  const src = fs.readFileSync(path.join(ASSETS, "js/i18n.js"), "utf8");
  const onChange = src.indexOf("onLocaleChanged");
  assert.ok(onChange !== -1, "expected an onLocaleChanged subscription in i18n.js");
  assert.ok(
    src.slice(onChange).includes("_runRenderers()"),
    "the onLocaleChanged handler must call _runRenderers(), otherwise JS-rendered " +
      "text stays in the previous language after a switch"
  );
});

test("a renderer that throws cannot leave the page stuck at visibility:hidden", () => {
  const src = fs.readFileSync(path.join(ASSETS, "js/i18n.js"), "utf8");
  const runner = src.slice(src.indexOf("function _safeRender"));
  assert.ok(
    /try\s*\{/.test(runner.slice(0, 300)),
    "_safeRender must swallow renderer exceptions — an unguarded throw would skip " +
      "_reveal() and leave html.i18n-pending set, hiding the whole window"
  );
});
