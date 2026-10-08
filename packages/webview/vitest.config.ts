import react from "@vitejs/plugin-react";

export default {
  plugins: [react()],
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    environmentOptions: {
      happyDOM: { url: "http://localhost" },
    },
  },
};
