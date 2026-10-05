import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(
        new URL("./tests/extension/vscode-placeholder.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/scripts/promo-demo.test.mjs"],
    clearMocks: true,
    restoreMocks: true,
  },
});
