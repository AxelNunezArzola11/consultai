import type { NextConfig } from "next";

/**
 * Bundler decision (Spike 6 — Bryntum):
 * Next.js 16 defaults to Turbopack for BOTH `next dev` and `next build`.
 * Turbopack does NOT support bare CSS @import specifiers like `tw-animate-css`
 * or Tailwind v4 CSS-in-JS patterns (@apply, @theme, @custom-variant).
 * Spike 6 confirmed Bryntum Gantt renders correctly with webpack.
 *
 * Both dev and build scripts in package.json use `--webpack` to force webpack.
 * Do NOT remove `--webpack` or add `--turbopack`/`--turbo` to either script
 * without re-validating Bryntum rendering and the tw-animate-css CSS import.
 *
 * APP_BASE_URL rule (Spike 8):
 * All webhook/callback URLs MUST use APP_BASE_URL from env — never VERCEL_URL, never
 * window.location. Validated at startup in lib/constants/routes.ts.
 */
import path from "path";

const nextConfig: NextConfig = {
  // No special bundler config needed here — bundler is selected via CLI flag (--webpack).
  webpack(config) {
    // Alias the stub modules so webpack resolves them the same way TypeScript does.
    // Remove these aliases (and the stubs in lib/ag-studio/stubs/) once the real
    // `ag-studio` / `ag-studio-react` licensed packages are installed.
    config.resolve.alias = {
      ...config.resolve.alias,
      "ag-studio": path.resolve(
        __dirname,
        "lib/ag-studio/stubs/ag-studio.ts"
      ),
      "ag-studio-react": path.resolve(
        __dirname,
        "lib/ag-studio/stubs/ag-studio-react.ts"
      ),
    };
    return config;
  },
};

export default nextConfig;
