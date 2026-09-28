/**
 * Test runner entry point for @vscode/test-electron.
 * Loaded by the VS Code instance during integration testing.
 * Uses Mocha (tdd interface) to run the test suite.
 */
import * as path from "node:path";
import * as Mocha from "mocha";
import * as fs from "node:fs";

export function run(_folder: string, _id: string): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 30000,
  });

  const suiteDir = path.resolve(__dirname, "suite");

  // Load all test files
  const testFiles = fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(suiteDir, f));

  for (const file of testFiles) {
    mocha.addFile(file);
  }

  // Run the tests
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
