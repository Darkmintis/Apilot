#!/usr/bin/env node
/**
 * @apilot/mcp — MCP server exposing every Apilot action to AI assistants.
 *
 * When the editor extension is running it writes `.apilot/.local/bridge.json`
 * (localhost port + per-session token). Tool calls are then forwarded to the
 * extension, which resolves secrets from the OS keychain and keeps the GUI in
 * sync. Otherwise tools run here, with secrets from APILOT_SECRET_<name>.
 * Either way, the AI only ever sees redacted data.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Workspace } from "@apilot/core";
import { TOOLS, callTool } from "./tools.js";

function findRoot(): string {
  const fromEnv = process.env.APILOT_PROJECT_ROOT;
  if (fromEnv) return resolve(fromEnv);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".apilot", "apilot.yaml"))) return dir;
    if (dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();
const ws = new Workspace(root);

interface Bridge {
  port: number;
  token: string;
}

async function viaBridge(name: string, args: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false }> {
  let bridge: Bridge;
  try {
    bridge = JSON.parse(readFileSync(join(root, ".apilot", ".local", "bridge.json"), "utf-8")) as Bridge;
  } catch {
    return { ok: false };
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ name, args }),
    });
  } catch {
    return { ok: false }; // editor closed — fall back to standalone
  }
  const payload = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || payload.error) throw new Error(payload.error ?? `Editor bridge returned ${res.status}`);
  return { ok: true, result: payload.result };
}

const server = new Server({ name: "apilot-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as { name: string; inputSchema: { type: "object" } }[] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const bridged = await viaBridge(name, args);
    const result = bridged.ok ? bridged.result : await callTool(ws, name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`[apilot-mcp] ready — project root: ${root}`);
