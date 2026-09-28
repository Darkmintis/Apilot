import { configDefaults } from "vitest/config";

export default {
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/**/*.test.ts", "src/types.ts"],
    },
    ...configDefaults,
  },
};
