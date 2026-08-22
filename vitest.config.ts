import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run source TypeScript test files — exclude compiled dist/ copies
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
