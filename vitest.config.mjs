import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Exclude Playwright spec files — they use @playwright/test, not vitest
    exclude: [
      "**/node_modules/**",
      "**/tests/**",        // consultai/tests/ is Playwright only
      "**/*.spec.ts",       // any .spec.ts file outside tests/ (belt-and-suspenders)
    ],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
