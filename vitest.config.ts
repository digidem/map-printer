import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          globalSetup: ["e2e/global-setup.ts"],
        },
      },
    ],
  },
});
