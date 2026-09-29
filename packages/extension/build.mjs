// Bundles the extension host (CJS) and the MCP server (ESM, run by the editor with ELECTRON_RUN_AS_NODE).
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = { bundle: true, platform: "node", target: "node20", sourcemap: !production, minify: production, logLevel: "info" };

const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ["src/extension.ts"], format: "cjs", external: ["vscode"], outfile: "dist/extension.js" }),
  esbuild.context({
    ...common,
    entryPoints: ["../mcp/src/index.ts"],
    format: "esm",
    outfile: "dist/mcp.mjs",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
