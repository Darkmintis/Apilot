#!/usr/bin/env node
/** Runs the integration suite in a real VS Code against a throwaway copy of the MCP test project. */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { runTests } = require("@vscode/test-electron");

const extensionDevelopmentPath = path.resolve(__dirname, "..");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apilot-ext-test-"));
fs.cpSync(path.resolve(extensionDevelopmentPath, "../mcp/test-project"), workspace, { recursive: true });

runTests({
  extensionDevelopmentPath,
  extensionTestsPath: path.join(extensionDevelopmentPath, "dist/test/runTest.js"),
  launchArgs: [workspace, "--disable-extensions"],
})
  .then(() => console.log("VS Code extension tests passed"))
  .catch((err) => {
    console.error("VS Code extension tests failed:", err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
