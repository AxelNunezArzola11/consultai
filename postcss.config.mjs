/** @type {import('postcss').Config} */
const config = {
  plugins: {
    // Tailwind v4 PostCSS plugin — required for webpack builds (next build --webpack).
    // Processes @import "tailwindcss", @theme, @custom-variant, @apply, and all
    // other Tailwind v4 CSS-in-CSS directives.
    // https://tailwindcss.com/docs/installation/using-postcss
    "@tailwindcss/postcss": {},
  },
};

export default config;
