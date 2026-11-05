import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The real package is types-only and has no runtime entry, so anything
      // that imports it cannot be loaded in vitest without a stand-in.
      obsidian: fileURLToPath(new URL("./testUtils/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov", "json-summary"],
      // Measured on the whole declared surface, so a module no test imports
      // counts as 0 %, not as absent.
      all: true,
      include: ["src/**/*.ts"],
      // Nothing else. Write the test or delete the code.
      exclude: ["src/**/*.d.ts"],
      // The bar is 100 on all four metrics; never lower it.
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
