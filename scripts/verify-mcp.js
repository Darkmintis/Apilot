#!/usr/bin/env node
/** CI verification: starts MCP server, sends initialize, checks response. */
const { spawn } = require("child_process");
const path = require("path");

const mcpPath = path.resolve(__dirname, "..", "packages", "mcp", "dist", "index.js");
const testProject = path.resolve(__dirname, "..", "packages", "mcp", "test-project");

const child = spawn("node", [mcpPath], {
  env: {
    ...process.env,
    APilot_PROJECT_ROOT: testProject,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ci", version: "1.0.0" } },
  }) + "\n"
);

setTimeout(() => {
  child.kill();
  try {
    const msg = JSON.parse(stdout.trim().split("\n").find((l) => l.trim()));
    if (msg.result?.serverInfo?.name === "apilot-mcp") {
      console.log("✅ MCP server initialized:", msg.result.serverInfo.name);
      process.exit(0);
    } else {
      console.error("❌ Unexpected response");
      process.exit(1);
    }
  } catch (e) {
    console.error("❌ MCP server failed:", stdout, stderr);
    process.exit(1);
  }
}, 1000);
