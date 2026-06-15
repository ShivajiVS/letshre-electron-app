/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan all files that contain Tailwind class names
  content: [
    "./assets/**/*.html",
    "./assets/**/*.js",
    "./src/renderer/**/*.js",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
