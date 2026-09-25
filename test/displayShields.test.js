"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const SHIELDS = require.resolve("../src/main/displayShields");
const STUBBED = {
  logger: require.resolve("../src/main/logger"),
  electron: require.resolve("electron"),
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function load(displays) {
  const created = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.shownInactive = false;
      this.topmost = null;
      created.push(this);
    }
    setAlwaysOnTop(on, level) {
      this.topmost = on ? level : null;
    }
    setVisibleOnAllWorkspaces() {}
    setBounds(bounds) {
      this.bounds = bounds;
    }
    showInactive() {
      this.shownInactive = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const screen = new EventEmitter();
  screen.getAllDisplays = () => displays;
  stub(STUBBED.electron, { BrowserWindow: FakeBrowserWindow, screen });
  const noop = () => {};
  stub(STUBBED.logger, { info: noop, warn: noop });
  delete require.cache[SHIELDS];
  return { shields: require(SHIELDS), created, screen };
}

const display = (id, x) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 } });

let h;
afterEach(() => {
  h?.shields.stop();
  for (const id of [...Object.values(STUBBED), SHIELDS]) {
    delete require.cache[id];
  }
});

test("every display but the interview's is covered, without taking focus", () => {
  const displays = [display(1, 0), display(2, 1920), display(3, -1920)];
  h = load(displays);
  h.shields.start(1);

  assert.deepStrictEqual(
    h.created.map((w) => w.bounds.x),
    [1920, -1920]
  );
  for (const shield of h.created) {
    assert.strictEqual(shield.options.focusable, false);
    assert.strictEqual(shield.options.skipTaskbar, true);
    assert.strictEqual(shield.topmost, "screen-saver");
    assert.ok(shield.shownInactive);
  }
});

test("a display plugged in mid-interview is covered too, and all go when it ends", () => {
  const displays = [display(1, 0)];
  h = load(displays);
  h.shields.start(1);
  assert.strictEqual(h.shields._internal.count(), 0);

  displays.push(display(2, 1920));
  h.screen.emit("display-added");
  assert.strictEqual(h.shields._internal.count(), 1);

  h.shields.stop();
  assert.strictEqual(h.shields._internal.count(), 0);
  assert.ok(h.created.every((w) => w.destroyed));
  assert.strictEqual(h.screen.listenerCount("display-added"), 0);
});
