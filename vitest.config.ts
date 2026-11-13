import { defineConfig } from "vitest/config";

/**
 * Test scope for the PrimeStack API.
 *
 * Without this file vitest walks the whole repository, so `npm test` also
 * collects vendored suites found inside stray package folders
 * (`node_modules.incomplete-*`, `.node_modules-restored`) and the legacy
 * `services/transfer-service` stub, which fails on its own database user.
 * Only this project's own tests under src/ are relevant here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "node_modules.incomplete-*/**",
      ".node_modules-restored/**",
      "services/**",
    ],
    environment: "node",
  },
});
