/**
 * src/renderer/role-selection.js
 * ────────────────────────────────
 * 4-step role selection state machine:
 *   confirm → (No) input → (needs_clarification) clarify → skills → lockdown
 *
 * All API calls go through main via IPC — tokens never touch this renderer.
 */

"use strict";

document.addEventListener("DOMContentLoaded", async () => {

  // ── DOM refs ────────────────────────────────────────────────────────────────

  // Step pills (header)
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

  // Sidebar
  const sidebarTitle = document.getElementById("sidebar-title");
  const sidebarDesc  = document.getElementById("sidebar-desc");
  const sidebarDots  = [
    document.getElementById("dot-1"),
    document.getElementById("dot-2"),
    document.getElementById("dot-3"),
    document.getElementById("dot-4"),
  ];

  // Panels
  const panels = [
    document.getElementById("panel-confirm"),
    document.getElementById("panel-input"),
    document.getElementById("panel-clarify"),
    document.getElementById("panel-skills"),
  ];

  // Confirm panel
  const confirmSkeleton   = document.getElementById("confirm-skeleton");
  const confirmContent    = document.getElementById("confirm-content");
  const confirmRoleName   = document.getElementById("confirm-role-name");
  const confirmRoleInline = document.getElementById("confirm-role-inline");
  const btnYes            = document.getElementById("btn-yes");
  const btnNo             = document.getElementById("btn-no");

  // Input panel
  const roleInput     = document.getElementById("role-input");
  const btnSubmitRole = document.getElementById("btn-submit-role");

  // Clarify panel
  const ambiguousRoleLabel = document.getElementById("ambiguous-role-label");
  const roleCardsEl        = document.getElementById("role-cards");
  const btnConfirmClarify  = document.getElementById("btn-confirm-clarify");

  // Skills panel
  const confirmedRoleLabel = document.getElementById("confirmed-role-label");
  const skillsGrid         = document.getElementById("skills-grid");
  const btnStartInterview  = document.getElementById("btn-start-interview");

  // Error banner (inline display:none/flex — see role-selection.html note)
  const rsError     = document.getElementById("rs-error");
  const rsErrorText = document.getElementById("rs-error-text");
  function showError(msg) { rsErrorText.textContent = msg; rsError.style.display = "flex"; }
  function hideError() { rsError.style.display = "none"; }

  // ── Sidebar copy per step ────────────────────────────────────────────────────
  const SIDEBAR = [
    { title: "Your Selected Role",  desc: "Review the role assigned to you. If it's correct, proceed directly to the interview. Otherwise, enter a different role." },
    { title: "Enter Your Role",     desc: "Type the role you're interviewing for. Our AI will tailor the interview questions to match your specific position." },
    { title: "Narrow It Down",      desc: "The role you entered covers several specialisations. Choose the one that best describes your expertise." },
    { title: "Skills Detected",     desc: "These are the key skills we'll evaluate during your interview. Review them and start when you're ready." },
  ];

  // ── State ────────────────────────────────────────────────────────────────────
  let profileRole         = "";   // role from candidate profile
  let pendingRole         = "";   // last submitted role string
  let selectedClarifyRole = "";   // picked in clarification step

  // ── Step navigation ──────────────────────────────────────────────────────────
  function goToStep(idx) {
    hideError();
    // Sidebar copy
    sidebarTitle.textContent = SIDEBAR[idx].title;
    sidebarDesc.textContent  = SIDEBAR[idx].desc;

    // Header pills
    stepPills.forEach((el, i) => {
      el.classList.remove("rs-step--active", "rs-step--done");
      if (i < idx)       el.classList.add("rs-step--done");
      else if (i === idx) el.classList.add("rs-step--active");
    });

    // Connector lines
    stepLines.forEach((el, i) => {
      el.classList.toggle("rs-step__line--done", i < idx);
    });

    // Sidebar progress dots
    sidebarDots.forEach((el, i) => {
      el.classList.toggle("rs-sidebar__dot--active", i === idx);
    });

    // Panels
    panels.forEach((p, i) => {
      if (i === idx) p.removeAttribute("hidden");
      else           p.setAttribute("hidden", "");
    });
  }

  // ── Load candidate profile ───────────────────────────────────────────────────
  try {
    const res = await window.electronAPI?.getCandidateProfile?.();
    if (res?.success && res.data?.role) {
      profileRole = res.data.role;
    }
  } catch { /* non-fatal */ }

  if (profileRole) {
    confirmRoleName.textContent   = profileRole;
    confirmRoleInline.textContent = profileRole;
    confirmSkeleton.setAttribute("hidden", "");
    confirmContent.removeAttribute("hidden");
    goToStep(0);
  } else {
    // No role from profile — skip confirm, go straight to input
    goToStep(1);
  }

  // ── Confirm step ─────────────────────────────────────────────────────────────

  btnYes.addEventListener("click", () => {
    setSubmitting(true);
    submitRole(profileRole);
  });

  btnNo.addEventListener("click", () => goToStep(1));

  // ── Input step ───────────────────────────────────────────────────────────────

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
    if (role) { setSubmitting(true); submitRole(role); }
  });

  // ── Clarify step ─────────────────────────────────────────────────────────────

  btnConfirmClarify.addEventListener("click", () => {
    if (selectedClarifyRole) { setSubmitting(true); submitRole(selectedClarifyRole); }
  });

  // ── Skills step ──────────────────────────────────────────────────────────────

  const startInterviewHTML = btnStartInterview.innerHTML; // capture for restore
  btnStartInterview.addEventListener("click", () => {
    if (btnStartInterview.disabled) { return; }
    // Fail loud if the bridge method is missing — never spin forever silently.
    if (typeof window.electronAPI?.proceedToInterview !== "function") {
      showError("Unable to start the interview. Please restart the app.");
      return;
    }
    btnStartInterview.disabled = true;
    btnStartInterview.innerHTML = `<span class="rs-spinner"></span> Starting…`;
    window.electronAPI.proceedToInterview();
    // Watchdog: successful navigation tears down this page. If this fires,
    // navigation never happened — restore the button so the user can retry.
    setTimeout(() => {
      btnStartInterview.disabled = false;
      btnStartInterview.innerHTML = startInterviewHTML;
      showError("That took too long. Please try again.");
    }, 6000);
  });

  // ── API submission ───────────────────────────────────────────────────────────

  async function submitRole(role) {
    pendingRole = role;
    hideError();
    if (typeof window.electronAPI?.submitRole !== "function") {
      showError("This action is unavailable. Please restart the app.");
      setSubmitting(false);
      return;
    }
    try {
      const res = await window.electronAPI.submitRole(role);
      if (!res?.ok) {
        showError(res?.error || "Couldn't process that role. Please try again.");
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
      showError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Busy state ───────────────────────────────────────────────────────────────

  const ARROW_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>`;
  const SPINNER    = `<span class="rs-spinner"></span>`;

  function setSubmitting(busy) {
    btnYes.disabled           = busy;
    btnSubmitRole.disabled    = busy;
    btnConfirmClarify.disabled = busy;

    if (busy) {
      btnYes.innerHTML           = `${SPINNER} Loading…`;
      btnSubmitRole.innerHTML    = `${SPINNER} Checking role…`;
      btnConfirmClarify.innerHTML = `${SPINNER} Confirming…`;
    } else {
      btnYes.innerHTML = `Yes, continue ${ARROW_ICON}`;
      btnSubmitRole.disabled  = roleInput.value.trim().length === 0;
      btnSubmitRole.innerHTML = `Continue to Interview ${ARROW_ICON}`;

      const label = selectedClarifyRole
        ? `Confirm — ${escHtml(selectedClarifyRole)} ${ARROW_ICON}`
        : `Confirm selection ${ARROW_ICON}`;
      btnConfirmClarify.disabled = selectedClarifyRole.length === 0;
      btnConfirmClarify.innerHTML = label;
    }
  }

  // ── Render clarification cards ───────────────────────────────────────────────

  function renderClarification(suggestions) {
    selectedClarifyRole = "";
    btnConfirmClarify.disabled = true;
    btnConfirmClarify.innerHTML = `Confirm selection ${ARROW_ICON}`;
    ambiguousRoleLabel.textContent = pendingRole;
    roleCardsEl.innerHTML = "";

    suggestions.forEach((role, i) => {
      const card = document.createElement("div");
      card.className = "rs-role-card";
      card.style.animationDelay = `${i * 60}ms`;
      card.innerHTML = `
        <div class="rs-role-card__radio"></div>
        <span class="rs-role-card__label">${escHtml(role)}</span>`;
      card.addEventListener("click", () => {
        roleCardsEl.querySelectorAll(".rs-role-card").forEach((c) =>
          c.classList.remove("rs-role-card--selected")
        );
        card.classList.add("rs-role-card--selected");
        selectedClarifyRole = role;
        btnConfirmClarify.disabled = false;
        btnConfirmClarify.innerHTML = `Confirm — ${escHtml(role)} ${ARROW_ICON}`;
      });
      roleCardsEl.appendChild(card);
    });
  }

  // ── Render skills chips ───────────────────────────────────────────────────────

  function renderSkills(skills, role) {
    confirmedRoleLabel.textContent = role;
    skillsGrid.innerHTML = "";

    if (skills.length === 0) {
      skillsGrid.innerHTML = `<p class="rs-skills-empty">No specific skills listed — the interview will adapt in real-time.</p>`;
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
        <span>${escHtml(skill)}</span>`;
      skillsGrid.appendChild(chip);
    });
  }

});

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
