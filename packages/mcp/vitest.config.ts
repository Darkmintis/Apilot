import { configDefaults } from "vitest/config";
export default {
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    ...configDefaults,
  },
};
