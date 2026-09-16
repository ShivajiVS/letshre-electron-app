"use strict";

/**
 * Guards the design system in assets/css/base.css.
 *
 * Every page once carried its own palette — how-it-works shipped a slate/blue
 * set that shared no value with the rest of the app, permissions hardcoded its
 * own greens and reds beside the semantic tokens, and five pages sized in px so
 * they never scaled past a laptop. These assert the token layer is the only
 * source: colour comes from base.css, type sizes are rem so the fluid root
 * drives them, and no page redefines a token it does not own.
 *
 * The app is deliberately blue, black, red and white. Any other hue is a
 * regression, so the palette itself is asserted here too.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS_DIR = path.join(__dirname, "../assets/css");
const ASSETS = path.join(__dirname, "../assets");

/** base.css declares the tokens; fonts.css is generated. */
const NOT_PAGE_STYLESHEETS = new Set(["base.css", "fonts.css"]);

function pageStylesheets() {
  return fs
    .readdirSync(CSS_DIR)
    .filter((f) => f.endsWith(".css") && !NOT_PAGE_STYLESHEETS.has(f))
    .map((f) => ({ file: f, css: fs.readFileSync(path.join(CSS_DIR, f), "utf8") }));
}

/** Strips comments so commented-out rules never trip an assertion. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("no page stylesheet hardcodes a hex colour — they come from base.css", () => {
  for (const { file, css } of pageStylesheets()) {
    const hex = [...stripComments(css).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.deepStrictEqual(
      hex,
      [],
      `${file} hardcodes ${hex.join(", ")} — add a token to base.css and use var() instead`
    );
  }
});

test("no page stylesheet sizes text in px — rem lets the fluid root scale it", () => {
  for (const { file, css } of pageStylesheets()) {
    const px = [...stripComments(css).matchAll(/font-size:\s*[^;]*\d\s*px/g)].map((m) => m[0]);
    assert.deepStrictEqual(
      px,
      [],
      `${file} sets ${px.join(", ")} — use a --text-* token so the page scales`
    );
  }
});

test("no page stylesheet redefines a base token", () => {
  const base = fs.readFileSync(path.join(CSS_DIR, "base.css"), "utf8");
  const owned = new Set([...base.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));

  for (const { file, css } of pageStylesheets()) {
    const redefined = [...stripComments(css).matchAll(/^\s*(--[\w-]+):/gm)]
      .map((m) => m[1])
      .filter((name) => owned.has(name));
    assert.deepStrictEqual(
      redefined,
      [],
      `${file} redefines ${redefined.join(", ")} — that silently repaints every page that loads it`
    );
  }
});

test("every page loads the token layer before its own stylesheet", () => {
  const pages = fs
    .readdirSync(ASSETS)
    .filter((f) => f.endsWith(".html") && f !== "recorder.html")
    .map((f) => ({ file: f, html: fs.readFileSync(path.join(ASSETS, f), "utf8") }));

  assert.ok(pages.length > 0, "no pages found to check");

  for (const { file, html } of pages) {
    const links = [...html.matchAll(/href="\.\/css\/([\w-]+\.css)"/g)].map((m) => m[1]);
    assert.ok(links.includes("base.css"), `${file} does not load base.css — it has no tokens`);

    const ownSheet = file.replace(/\.html$/, ".css");
    if (links.includes(ownSheet)) {
      assert.ok(
        links.indexOf("base.css") < links.indexOf(ownSheet),
        `${file} loads ${ownSheet} before base.css — the page cannot see the tokens it uses`
      );
    }
  }
});

test("every page opts into the fluid root so the whole flow scales together", () => {
  const pages = fs.readdirSync(ASSETS).filter((f) => f.endsWith(".html") && f !== "recorder.html");

  for (const file of pages) {
    const html = fs.readFileSync(path.join(ASSETS, file), "utf8");
    const htmlTag = html.match(/<html[^>]*>/)?.[0] ?? "";
    assert.match(
      htmlTag,
      /class="[^"]*\bfluid-scale\b/,
      `${file} is missing the fluid-scale class — it stays laptop-sized on a 4K panel`
    );
  }
});

/** Hue in degrees, plus saturation, for a #rgb or #rrggbb colour. */
function hueOf(hex) {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, sat: 0 };
  }
  let hue;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return { hue: (hue * 60 + 360) % 360, sat: delta / max };
}

/** Amber sits at 32°, so the floor has to be below 40 to catch it. Red lands at 4°. */
const BANNED_HUE = { from: 25, to: 170 };

function bannedHue(hex) {
  const { hue, sat } = hueOf(hex);
  // Near-greys carry no hue worth judging.
  return sat >= 0.12 && hue >= BANNED_HUE.from && hue <= BANNED_HUE.to;
}

test("the palette is blue, black, red and white — no green or yellow", () => {
  const base = fs.readFileSync(path.join(CSS_DIR, "base.css"), "utf8");
  const offenders = [];

  for (const m of stripComments(base).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) {
    const [, token, hex] = m;
    if (bannedHue(hex)) {
      offenders.push(`${token}: ${hex} (hue ${Math.round(hueOf(hex).hue)}°)`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    `green/yellow is not in the palette — ${offenders.join(", ")}`
  );
});

test("the hue guard still rejects the palette this app moved away from", () => {
  for (const green of ["#16a34a", "#bbf7d0", "#4ade80"]) {
    assert.ok(bannedHue(green), `${green} is green and should be rejected`);
  }
  for (const amber of ["#d97706", "#fde68a", "#96681f"]) {
    assert.ok(bannedHue(amber), `${amber} is amber and should be rejected`);
  }
  for (const keep of ["#0055ff", "#b8d0ff", "#d92d20", "#fecdca", "#111111", "#ffffff"]) {
    assert.ok(!bannedHue(keep), `${keep} is in the palette and must pass`);
  }
});
