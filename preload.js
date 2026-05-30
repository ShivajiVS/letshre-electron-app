window.addEventListener("DOMContentLoaded", () => {

  document.addEventListener("contextmenu", e => e.preventDefault());

  document.addEventListener("keydown", (e) => {

    if (e.ctrlKey && ["c", "v", "u"].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }

    if (e.key === "PrintScreen") {
      e.preventDefault();
    }

  });

});