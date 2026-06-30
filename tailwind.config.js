/** @type {import('tailwindcss').Config} */
module.exports = {
  // Only violation.html uses Tailwind — all other pages use raw CSS
  content: [
    "./assets/violation.html",
    "./src/renderer/violation.js",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
