import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite config for the Apilot webview UI.
// Output is a single JS bundle consumed by the VS Code webview panel.
export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      name: "ApilotWebview",
      entry: path.resolve(__dirname, "src/index.tsx"),
      formats: ["iife"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [],
      output: {
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
  },
  server: {
    port: 3100,
    hmr: true,
  },
});
