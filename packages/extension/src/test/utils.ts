import * as path from "node:path";

export function getTestWorkspacePath(): string {
  return path.resolve(__dirname, "../../../../mcp/test-project");
}

export function getExtensionPath(): string {
  return path.resolve(__dirname, "..", "..");
}
