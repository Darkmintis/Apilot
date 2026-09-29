import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Single IIFE bundle + style.css, loaded by the extension's webview panel.
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: path.resolve(__dirname, "../extension/dist/webview"),
    emptyOutDir: true,
    lib: {
      name: "ApilotWebview",
      entry: path.resolve(__dirname, "src/index.tsx"),
      formats: ["iife"],
      fileName: () => "index.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: "style.css" } },
  },
});
