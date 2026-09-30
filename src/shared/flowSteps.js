"use strict";

// The setup steps between Take interview and the interview, in order. Required
// by the flow guard and loaded as a classic script (window.FlowSteps) by the
// step indicator, so the two can't disagree.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.FlowSteps = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STEPS = Object.freeze(
    [
      { id: "language", labelKey: "flowSteps.language", fallback: "Language" },
      { id: "preflight", labelKey: "flowSteps.preflight", fallback: "Security check" },
      { id: "permissions", labelKey: "flowSteps.permissions", fallback: "Permissions" },
      { id: "identity", labelKey: "flowSteps.identity", fallback: "Identity check" },
      { id: "role", labelKey: "flowSteps.role", fallback: "Role" },
      { id: "rules", labelKey: "flowSteps.rules", fallback: "Interview rules" },
    ].map(Object.freeze)
  );

  const STEP_IDS = Object.freeze(STEPS.map((s) => s.id));

  // The steps the flow guard watches: everything after the security check.
  const GUARDED_STEP_IDS = Object.freeze(STEP_IDS.slice(STEP_IDS.indexOf("preflight") + 1));

  /** Packaged builds may offer English alone, and a one-option page is a dead end. */
  function languageStepShown(locales) {
    return Array.isArray(locales) && locales.length > 1;
  }

  function visibleSteps({ languageShown = false } = {}) {
    return STEPS.filter((s) => s.id !== "language" || languageShown);
  }

  /**
   * @param {string} id
   * @param {{languageShown?: boolean}} [opts]
   * @returns {{number: number, total: number, step: object}|null} null for a step that isn't shown
   */
  function stepPosition(id, opts) {
    const steps = visibleSteps(opts);
    const index = steps.findIndex((s) => s.id === id);
    return index === -1 ? null : { number: index + 1, total: steps.length, step: steps[index] };
  }

  return { STEPS, STEP_IDS, GUARDED_STEP_IDS, languageStepShown, visibleSteps, stepPosition };
});
