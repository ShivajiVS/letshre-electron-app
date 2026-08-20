/**
 * 4-step role selection state machine:
 *   confirm → (No) input → (needs_clarification) clarify → skills → lockdown
 * All API calls go through main via IPC — tokens never touch this renderer.
 */

"use strict";

/** Translate with an English fallback for the non-Electron preview (window.t absent). */
function tr(key, fallback, params) {
  return window.t ? window.t(key, params) : fallback;
}

const ARROW_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>`;
const START_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>`;
const SPINNER = `<span class="rs-spinner"></span>`;

document.addEventListener("DOMContentLoaded", async () => {
  const stepPills = [
    document.getElementById("step-pill-confirm"),
    document.getElementById("step-pill-input"),
    document.getElementById("step-pill-clarify"),
    document.getElementById("step-pill-skills"),
  ];
  const stepLines = [
    document.getElementById("line-1"),
    document.getElementById("line-2"),
    document.getElementById("line-3"),
  ];

  const sidebarTitle = document.getElementById("sidebar-title");
  const sidebarDesc = document.getElementById("sidebar-desc");
  const sidebarDots = [
    document.getElementById("dot-1"),
    document.getElementById("dot-2"),
    document.getElementById("dot-3"),
    document.getElementById("dot-4"),
  ];

  const panels = [
    document.getElementById("panel-confirm"),
    document.getElementById("panel-input"),
    document.getElementById("panel-clarify"),
    document.getElementById("panel-skills"),
  ];

  const confirmSkeleton = document.getElementById("confirm-skeleton");
  const confirmContent = document.getElementById("confirm-content");
  const confirmRoleName = document.getElementById("confirm-role-name");
  const confirmRoleInline = document.getElementById("confirm-role-inline");
  const btnYes = document.getElementById("btn-yes");
  const btnNo = document.getElementById("btn-no");

  const roleInput = document.getElementById("role-input");
  const btnSubmitRole = document.getElementById("btn-submit-role");

  const ambiguousRoleLabel = document.getElementById("ambiguous-role-label");
  const roleCardsEl = document.getElementById("role-cards");
  const btnConfirmClarify = document.getElementById("btn-confirm-clarify");

  const confirmedRoleLabel = document.getElementById("confirmed-role-label");
  const skillsGrid = document.getElementById("skills-grid");
  const btnStartInterview = document.getElementById("btn-start-interview");

  // Error banner (inline display:none/flex — see role-selection.html note)
  const rsError = document.getElementById("rs-error");
  const rsErrorText = document.getElementById("rs-error-text");

  const SIDEBAR = [
    {
      titleKey: ["role.sidebarTitle", "Your Selected Role"],
      descKey: [
        "role.sidebarDesc",
        "Review the role assigned to you. If it's correct, proceed directly to the interview. Otherwise, enter a different role.",
      ],
    },
    {
      titleKey: ["role.sidebarInputTitle", "Enter Your Role"],
      descKey: [
        "role.sidebarInputDesc",
        "Type the role you're interviewing for. Our AI will tailor the interview questions to match your specific position.",
      ],
    },
    {
      titleKey: ["role.sidebarClarifyTitle", "Narrow It Down"],
      descKey: [
        "role.sidebarClarifyDesc",
        "The role you entered covers several specialisations. Choose the one that best describes your expertise.",
      ],
    },
    {
      titleKey: ["role.sidebarSkillsTitle", "Skills Detected"],
      descKey: [
        "role.sidebarSkillsDesc",
        "These are the key skills we'll evaluate during your interview. Review them and start when you're ready.",
      ],
    },
  ];

  // State renderI18n() re-derives text from — kept in sync by the step/submit
  // logic below so a locale switch mid-flow can redraw without reverting it.
  let currentStepIdx = 0;
  let isBusy = false; // btnYes / btnSubmitRole / btnConfirmClarify request in flight
  let isStartingInterview = false; // btnStartInterview post-click, own lifecycle
  let selectedClarifyRole = "";
  let skillsEmpty = false;
  let errorState = null; // { key, fallback } | { raw: string } | null

  function confirmClarifyLabel(role) {
    return role
      ? `${tr("role.confirmWithRole", "Confirm — {role}", { role: window.escHtml(role) })} ${ARROW_ICON}`
      : `${tr("role.confirmSelection", "Confirm selection")} ${ARROW_ICON}`;
  }

  function renderI18n() {
    sidebarTitle.textContent = tr(...SIDEBAR[currentStepIdx].titleKey);
    sidebarDesc.textContent = tr(...SIDEBAR[currentStepIdx].descKey);

    if (isBusy) {
      btnYes.innerHTML = `${SPINNER} ${tr("role.loading", "Loading…")}`;
      btnSubmitRole.innerHTML = `${SPINNER} ${tr("role.checkingRole", "Checking role…")}`;
      btnConfirmClarify.innerHTML = `${SPINNER} ${tr("role.confirming", "Confirming…")}`;
    } else {
      btnYes.innerHTML = `${tr("role.yes", "Yes, continue")} ${ARROW_ICON}`;
      btnSubmitRole.innerHTML = `${tr("role.continueToInterview", "Continue to Interview")} ${ARROW_ICON}`;
      btnConfirmClarify.innerHTML = confirmClarifyLabel(selectedClarifyRole);
    }

    btnStartInterview.innerHTML = isStartingInterview
      ? `${SPINNER} ${tr("role.starting", "Starting…")}`
      : `${tr("role.startInterview", "Start Interview")} ${START_ICON}`;

    if (skillsEmpty) {
      skillsGrid.innerHTML = `<p class="rs-skills-empty">${tr("role.noSkillsListed", "No specific skills listed — the interview will adapt in real-time.")}</p>`;
    }

    if (errorState) {
      rsErrorText.textContent =
        "raw" in errorState ? errorState.raw : tr(errorState.key, errorState.fallback);
    }
  }

  window.i18n?.registerRenderer?.(renderI18n);

  if (window.i18n?.ready) {
    await window.i18n.ready;
  }

  function showError(msg) {
    rsErrorText.textContent = msg;
    rsError.style.display = "flex";
  }
  function hideError() {
    errorState = null;
    rsError.style.display = "none";
  }
  function showTranslatedError(key, fallback) {
    errorState = { key, fallback };
    showError(tr(key, fallback));
  }
  function showRawError(text) {
    errorState = { raw: text };
    showError(text);
  }

  let profileRole = ""; // role from candidate profile
  let pendingRole = ""; // last submitted role string

  // Role-decision state, handed to the interview site at Start Interview.
  //   Yes (keep assigned role) → is_custom_role: false; backend uses the profile role.
  //   No  (chose a new role)   → is_custom_role: true + selected_role + manual_skills.
  let isCustomRole = false; // false = confirmed profile role, true = custom
  let finalRole = ""; // the role shown on the skills panel
  let finalSkills = []; // the skills shown on the skills panel

  function goToStep(idx) {
    currentStepIdx = idx;
    hideError();
    renderI18n();

    stepPills.forEach((el, i) => {
      el.classList.remove("rs-step--active", "rs-step--done");
      if (i < idx) {
        el.classList.add("rs-step--done");
      } else if (i === idx) {
        el.classList.add("rs-step--active");
      }
    });

    stepLines.forEach((el, i) => {
      el.classList.toggle("rs-step__line--done", i < idx);
    });

    sidebarDots.forEach((el, i) => {
      el.classList.toggle("rs-sidebar__dot--active", i === idx);
    });

    panels.forEach((p, i) => {
      if (i === idx) {
        p.removeAttribute("hidden");
      } else {
        p.setAttribute("hidden", "");
      }
    });
  }

  try {
    const res = await window.electronAPI?.getCandidateProfile?.();
    if (res?.success && res.data?.role) {
      profileRole = res.data.role;
    }
  } catch {
    /* non-fatal */
  }

  if (profileRole) {
    confirmRoleName.textContent = profileRole;
    confirmRoleInline.textContent = profileRole;
    confirmSkeleton.setAttribute("hidden", "");
    confirmContent.removeAttribute("hidden");
    goToStep(0);
  } else {
    // No role from profile — skip confirm, go straight to input
    goToStep(1);
  }

  btnYes.addEventListener("click", () => {
    // Keeping the assigned profile role → not a custom role.
    isCustomRole = false;
    setSubmitting(true);
    submitRole(profileRole);
  });

  btnNo.addEventListener("click", () => {
    // Entering a different role → custom-role flow.
    isCustomRole = true;
    goToStep(1);
  });

  roleInput.addEventListener("input", () => {
    btnSubmitRole.disabled = roleInput.value.trim().length === 0;
  });

  roleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnSubmitRole.disabled) {
      setSubmitting(true);
      submitRole(roleInput.value.trim());
    }
  });

  btnSubmitRole.addEventListener("click", () => {
    const role = roleInput.value.trim();
    if (role) {
      setSubmitting(true);
      submitRole(role);
    }
  });

  btnConfirmClarify.addEventListener("click", () => {
    if (selectedClarifyRole) {
      setSubmitting(true);
      submitRole(selectedClarifyRole);
    }
  });

  btnStartInterview.addEventListener("click", () => {
    if (btnStartInterview.disabled) {
      return;
    }
    // Fail loud if the bridge method is missing — never spin forever silently.
    if (typeof window.electronAPI?.proceedToInterview !== "function") {
      showTranslatedError("role.startUnavailable", "Unable to start the interview. Please restart the app.");
      return;
    }
    const idleHTML = btnStartInterview.innerHTML; // capture for restore
    btnStartInterview.disabled = true;
    isStartingInterview = true;
    renderI18n();
    // Hand the role decision to the interview site. Yes → is_custom_role:false
    // only; No → is_custom_role:true with the chosen role + detected skills.
    const payload = isCustomRole
      ? { is_custom_role: true, selected_role: [finalRole], manual_skills: finalSkills }
      : { is_custom_role: false };
    window.electronAPI.proceedToInterview(payload);
    // Watchdog: successful navigation tears down this page. If this fires,
    // navigation never happened — restore the button so the user can retry.
    window.armButtonRestore(btnStartInterview, idleHTML, {
      onRestore: () => {
        isStartingInterview = false;
        renderI18n();
        showTranslatedError("role.startTimedOut", "That took too long. Please try again.");
      },
    });
  });

  async function submitRole(role) {
    pendingRole = role;
    hideError();
    if (typeof window.electronAPI?.submitRole !== "function") {
      showTranslatedError("role.actionUnavailable", "This action is unavailable. Please restart the app.");
      setSubmitting(false);
      return;
    }
    try {
      const res = await window.electronAPI.submitRole(role);
      if (!res?.ok) {
        if (res?.error) {
          showRawError(res.error);
        } else {
          showTranslatedError("role.roleProcessFailed", "Couldn't process that role. Please try again.");
        }
        setSubmitting(false);
        return;
      }
      const data = res.data || {};
      if (data.needs_clarification) {
        renderClarification(data.suggestions || []);
        goToStep(2);
      } else {
        renderSkills(data.skills || [], role);
        goToStep(3);
      }
    } catch {
      showTranslatedError("role.networkError", "Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function setSubmitting(busy) {
    isBusy = busy;
    btnYes.disabled = busy;
    btnSubmitRole.disabled = busy;
    btnConfirmClarify.disabled = busy;
    if (!busy) {
      btnSubmitRole.disabled = roleInput.value.trim().length === 0;
      btnConfirmClarify.disabled = selectedClarifyRole.length === 0;
    }
    renderI18n();
  }

  function renderClarification(suggestions) {
    selectedClarifyRole = "";
    btnConfirmClarify.disabled = true;
    ambiguousRoleLabel.textContent = pendingRole;
    roleCardsEl.innerHTML = "";

    suggestions.forEach((role, i) => {
      const card = document.createElement("div");
      card.className = "rs-role-card";
      card.style.animationDelay = `${i * 60}ms`;
      card.innerHTML = `
        <div class="rs-role-card__radio"></div>
        <span class="rs-role-card__label">${window.escHtml(role)}</span>`;
      card.addEventListener("click", () => {
        roleCardsEl
          .querySelectorAll(".rs-role-card")
          .forEach((c) => c.classList.remove("rs-role-card--selected"));
        card.classList.add("rs-role-card--selected");
        selectedClarifyRole = role;
        btnConfirmClarify.disabled = false;
        btnConfirmClarify.innerHTML = confirmClarifyLabel(role);
      });
      roleCardsEl.appendChild(card);
    });
  }

  function renderSkills(skills, role) {
    finalRole = role;
    finalSkills = Array.isArray(skills) ? skills : [];
    confirmedRoleLabel.textContent = role;
    skillsGrid.innerHTML = "";
    skillsEmpty = finalSkills.length === 0;

    if (skillsEmpty) {
      skillsGrid.innerHTML = `<p class="rs-skills-empty">${tr("role.noSkillsListed", "No specific skills listed — the interview will adapt in real-time.")}</p>`;
      return;
    }

    skills.forEach((skill, i) => {
      const chip = document.createElement("div");
      chip.className = "rs-skill-chip";
      chip.style.animationDelay = `${i * 55}ms`;
      chip.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>${window.escHtml(skill)}</span>`;
      skillsGrid.appendChild(chip);
    });
  }
});
