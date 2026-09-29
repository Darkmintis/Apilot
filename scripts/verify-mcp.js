#!/usr/bin/env node
/**
 * Smoke test: start the MCP server over stdio, list tools, and call one.
 * Usage: node scripts/verify-mcp.js [path/to/mcp.js]
 */
const { spawn } = require("child_process");
const path = require("path");

const mcpPath = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "packages", "mcp", "dist", "index.js"));
const testProject = path.resolve(__dirname, "..", "packages", "mcp", "test-project");

const child = spawn(process.execPath, [mcpPath], {
  env: { ...process.env, APILOT_PROJECT_ROOT: testProject, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const pending = new Map();
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  }
});

let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const fail = (why) => {
  console.error(`❌ ${why}\n${stderr}`);
  child.stdin.end();
  process.exit(1);
};

setTimeout(() => fail("timed out"), 15000).unref();

(async () => {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ci", version: "1.0.0" } });
  if (init.result?.serverInfo?.name !== "apilot-mcp") fail("bad initialize response");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  const names = tools.result?.tools?.map((t) => t.name) ?? [];
  if (names.length < 20) fail(`expected 20+ tools, got ${names.length}`);

  const list = await rpc("tools/call", { name: "list_endpoints", arguments: {} });
  const data = JSON.parse(list.result?.content?.[0]?.text ?? "{}");
  if (!data.endpoints?.some((e) => e.id === "orders.list")) fail(`list_endpoints missing orders.list: ${JSON.stringify(list)}`);

  const secret = await rpc("tools/call", { name: "set_variable", arguments: { name: "authToken", type: "secret", value: "x" } });
  if (!secret.result?.isError) fail("set_variable must refuse secret values");

  console.log(`✅ MCP server OK: ${names.length} tools, ${data.endpoints.length} endpoints`);
  child.stdin.end(); // the server exits when its client disconnects
  process.exit(0);
})();
