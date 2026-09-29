/**
 * "Step 3 of 5 · Identity check" in the top bar of the setup pages. The page
 * names its step on #step-indicator[data-flow-step]; the order comes from
 * src/shared/flowSteps.js, which the flow guard uses too. Include after
 * i18n.js and flowSteps.js.
 */

/* eslint-env browser */
"use strict";

(function () {
  const el = document.getElementById("step-indicator");
  const Steps = window.FlowSteps;
  const practice = new URLSearchParams(window.location.search).get("mode") === "practice";
  if (!el || !Steps || practice) {
    return;
  }

  let position = null;

  function tr(key, fallback, params) {
    if (window.t) {
      return window.t(key, params);
    }
    return fallback.replace(/\{(\w+)\}/g, (match, token) =>
      params && token in params ? String(params[token]) : match
    );
  }

  function render() {
    if (!position) {
      el.hidden = true;
      return;
    }
    const name = tr(position.step.labelKey, position.step.fallback);
    const dots = document.createElement("span");
    dots.className = "step-indicator__dots";
    dots.setAttribute("aria-hidden", "true");
    for (let i = 1; i <= position.total; i++) {
      const dot = document.createElement("span");
      const state = i < position.number ? "done" : i === position.number ? "current" : "todo";
      dot.className = `step-indicator__dot step-indicator__dot--${state}`;
      dots.appendChild(dot);
    }
    const label = document.createElement("span");
    label.className = "step-indicator__label";
    label.textContent = tr("flowSteps.progress", "Step {number} of {total} · {name}", {
      number: position.number,
      total: position.total,
      name,
    });
    el.replaceChildren(dots, label);
    el.hidden = false;
  }

  window.i18n?.registerRenderer?.(render);

  Promise.all([window.electronAPI?.getSupportedLocales?.(), window.i18n?.ready])
    .then(([locales]) => {
      const languageShown = Steps.languageStepShown(locales);
      position = Steps.stepPosition(el.dataset.flowStep, { languageShown });
      render();
    })
    .catch(() => {});
})();
