#!/usr/bin/env node
/**
 * VS Code extension test runner using @vscode/test-electron.
 * Downloads VS Code, launches it with the test workspace, and runs
 * the test suite defined in src/test/runTest.ts + src/test/suite/*.
 */
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

const extensionDir = __dirname;
const workspacePath = path.resolve(extensionDir, "../../packages/mcp/test-project");

async function main() {
  try {
    const extensionDevelopmentPath = extensionDir;
    const extensionTestsPath = path.resolve(extensionDir, "./dist/test/runTest.js");

    // Download VS Code, unzip it and start the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
      extensionDevelopmentPath: extensionDir,
    });

    console.log("✅ VS Code extension tests passed");
    process.exit(0);
  } catch (err) {
    console.error("❌ VS Code extension tests failed:", err);
    process.exit(1);
  }
}

main();
