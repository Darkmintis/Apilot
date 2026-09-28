#!/usr/bin/env node
/**
 * Bundle the VS Code extension with esbuild.
 * VS Code extensions must be bundled because the `vscode` module is
 * treated as external by the editor runtime — raw tsc output with
 * `import * as vscode from 'vscode'` will fail at runtime.
 */
const { build } = require("esbuild");
const path = require("node:path");
const { dirname } = require("node:path");

const extensionDir = path.resolve(__dirname, "..", "packages", "extension");
const isWatch = process.argv.includes("--watch");

build({
  entryPoints: [path.join(extensionDir, "src", "extension.ts")],
  bundle: true,
  minify: !isWatch,
  sourcemap: !isWatch,
  outfile: path.join(extensionDir, "dist", "extension.js"),
  format: "cjs",
  platform: "node",
  external: ["vscode"], // never bundle the vscode module
  logLevel: "info",
  watch: isWatch,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

if (isWatch) {
  console.log("[esbuild] Watching extension source...");
}
