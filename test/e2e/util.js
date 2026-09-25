"use strict";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The page's own window.t, for strings with plural blocks the harness can't expand. */
function pageT(ctx, key, params) {
  return ctx.eval(`window.t(${JSON.stringify(key)}, ${JSON.stringify(params || {})})`);
}

module.exports = { delay, deferred, pageT };
