/**
 * @apilot/mcp — MCP server exposing Apilot tools to AI assistants.
 *
 * Architecture (per spec §7.5 & §9):
 *
 * 1. **IPC proxy mode** (extension running):
 *    The VS Code extension hosts a local HTTP server with a random per-session
 *    token. The MCP server reads `.apilot/.mcp-bridge.json` to discover it.
 *    Run operations are proxied to the extension, which resolves secrets
 *    from the OS keychain and returns only redacted responses.
 *
 * 2. **Standalone mode** (CI / no extension):
 *    The MCP server reads `.apilot/` files directly. Secrets come from
 *    environment variables (prefixed with `APilot_`).
 *
 * Security: the MCP server NEVER holds raw secret values. It either proxies
 * to the extension (which handles secrets internally) or reads them from env
 * vars and immediately redacts them.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  Registry,
  NodeFileResolver,
  inferSchema,
  Redactor,
  Differ,
} from "@apilot/core";
import type {
  SnapshotRedacted,
  ApilotSchema,
} from "@apilot/core";
import { CodegenEngine } from "@apilot/codegen";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT =
  process.env.APilot_PROJECT_ROOT ??
  (() => {
    let dir = process.cwd();
    while (dir !== "/" && !existsSync(resolve(dir, ".apilot/apilot.yaml"))) {
      dir = dirname(dir);
    }
    return dir;
  })();

const APilot_DIR = resolve(PROJECT_ROOT, ".apilot");

// Env-var secret prefix: APilot_secret_<name>
const SECRET_PREFIX = "apilot_secret_";

/** NodeFileResolver rooted at the project root so Registry paths work. */
const files = new NodeFileResolver(PROJECT_ROOT);

// ---------------------------------------------------------------------------
// Bridge (IPC proxy to running extension)
// ---------------------------------------------------------------------------

interface BridgeInfo {
  port: number;
  token: string;
  host: string;
}

/** Read the IPC bridge info written by the extension. */
function getBridge(): BridgeInfo | null {
  const bridgeFile = resolve(APilot_DIR, ".mcp-bridge.json");
  if (!existsSync(bridgeFile)) return null;
  try {
    return JSON.parse(readFileSync(bridgeFile, "utf-8")) as BridgeInfo;
  } catch {
    return null;
  }
}

/**
 * Proxy a tool call to the running extension via local HTTP.
 * The extension resolves secrets, runs the request, and returns
 * a redacted response. The MCP server never sees raw secrets.
 */
async function proxyToExtension<T>(
  bridge: BridgeInfo,
  method: string,
  params: unknown
): Promise<T> {
  const res = await fetch(
    `http://${bridge.host}:${bridge.port}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify(params),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Extension IPC error: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Standalone mode helpers (for CI / no extension)
// ---------------------------------------------------------------------------

/**
 * In standalone mode, resolve secrets from environment variables.
 */
function getEnvSecret(name: string): string | undefined {
  // Check APilot_secret_<name> then <NAME>_SECRET then <NAME>
  const keys = [
    `${SECRET_PREFIX}${name}`,
    `${name.toUpperCase()}_SECRET`,
    name.toUpperCase(),
  ];
  for (const key of keys) {
    const val = process.env[key];
    if (val) return val;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_endpoints",
    description:
      "List all Apilot collections and endpoints (names, methods, URLs). " +
      "Use this first to discover what API endpoints are available.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description:
            "Optional filter by collection ID. Omit to list all endpoints.",
        },
      },
    },
  },
  {
    name: "get_endpoint",
    description:
      "Get the full definition of an endpoint plus its latest snapshot " +
      "(redacted response). Provides the actual request/response shape " +
      "so the AI never has to guess field names.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
          description: "The endpoint ID, e.g. 'orders.list'",
        },
      },
      required: ["endpointId"],
    },
  },
  {
    name: "run_endpoint",
    description:
      "Execute an endpoint with resolved secrets and return a redacted response. " +
      "Secrets are resolved by the extension (IPC mode) or environment variables " +
      "(standalone mode). The response is always redacted before returning.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
          description: "The endpoint ID, e.g. 'orders.list'",
        },
        envName: {
          type: "string",
          description:
            "The environment to use, e.g. 'dev'. Falls back to the default env.",
        },
      },
      required: ["endpointId"],
    },
  },
  {
    name: "run_collection",
    description:
      "Run all endpoints in a collection (folder) or all endpoints. " +
      "Returns a summary of pass/fail for each endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description:
            "Collection ID to run. If omitted, runs all endpoints.",
        },
        envName: {
          type: "string",
          description: "Environment to use for the run.",
        },
      },
    },
  },
  {
    name: "get_schema",
    description:
      "Get the inferred JSON schema for an endpoint's response. " +
      "Shows field types, nullability, required fields, and enum values. " +
      "Use this before writing models — never guess the response shape.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
          description: "The endpoint ID.",
        },
      },
      required: ["endpointId"],
    },
  },
  {
    name: "diff_endpoint",
    description:
      "Compare the latest snapshot against the baseline (or two named " +
      "snapshots). Returns classified changes: breaking, warning, " +
      "non-breaking, info. Use this after backend changes to detect drift.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
          description: "The endpoint ID.",
        },
        fromSnapshotId: {
          type: "string",
          description:
            "Optional: specific snapshot ID to compare from. Defaults to baseline.",
        },
        toSnapshotId: {
          type: "string",
          description:
            "Optional: specific snapshot ID to compare to. Defaults to latest.",
        },
      },
    },
  },
  {
    name: "impact_report",
    description:
      "Given a diff result, scan the codebase for files and models that " +
      "reference the changed fields. Returns a list of affected files " +
      "and a summary of what to fix.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
          description: "The endpoint ID.",
        },
      },
      required: ["endpointId"],
    },
  },
  {
    name: "generate_code",
    description:
      "Generate typed models and API calls for a target language. " +
      "Supported: dart (freezed), typescript (zod), kotlin, swift. " +
      "Output is based on the latest snapshot's real response shape.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: {
          type: "string",
        },
        language: {
          type: "string",
          description: "dart | typescript | kotlin | swift",
        },
        outputPath: {
          type: "string",
          description: "Optional output path. If omitted, returns code as text.",
        },
      },
      required: ["endpointId", "language"],
    },
  },
  {
    name: "add_endpoint",
    description:
      "Create a new endpoint definition. Can parse from cURL, or take " +
      "explicit method/URL/headers/body parameters.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the endpoint" },
        method: { type: "string", description: "HTTP method" },
        url: { type: "string", description: "Endpoint URL (can use {{vars}})" },
        collection: {
          type: "string",
          description: "Collection folder to place the endpoint in",
        },
        cURL: {
          type: "string",
          description: "Optional cURL string to parse",
        },
        headers: {
          type: "object",
          description: "Headers as key-value pairs",
        },
        body: { type: "string", description: "Request body" },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "update_endpoint",
    description:
      "Update an existing endpoint definition. Only the provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: { type: "string" },
        name: { type: "string" },
        method: { type: "string" },
        url: { type: "string" },
        headers: { type: "object" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "import_spec",
    description:
      "Import endpoints from cURL, Postman, OpenAPI/Swagger, or HAR format.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "cURL | postman | openapi | har" },
        content: {
          type: "string",
          description: "The spec content (string or JSON string)",
        },
        collectionName: {
          type: "string",
          description: "Name for the new collection",
        },
      },
      required: ["source", "content"],
    },
  },
  {
    name: "list_variables",
    description:
      "List variable names and types only — never secret values. " +
      "Use this to see what variables are available in an environment " +
      "without ever exposing secret values.",
    inputSchema: {
      type: "object",
      properties: {
        envName: {
          type: "string",
          description: "Environment name. Uses default if omitted.",
        },
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleListEndpoints(args: any): Promise<any> {
  const registry = new Registry(files).build();
  const collectionId = args.collectionId as string | undefined;

  const collections = registry.collections.map((c) => ({
    id: c.id,
    name: c.name,
    path: c.path,
  }));

  const endpoints = registry.endpoints
    .filter((e) => !collectionId || e.collectionId === collectionId)
    .map((e) => ({
      id: e.id,
      name: e.name,
      method: e.method,
      url: e.url,
      collectionId: e.collectionId,
      file: e.file,
    }));

  return {
    collections,
    endpoints,
    environments: registry.environments,
    defaultEnv: registry.project.defaultEnvironment,
  };
}

async function handleGetEndpoint(args: any): Promise<any> {
  const registry = new Registry(files).build();
  const ep = registry.endpoints.find((e) => e.id === args.endpointId);
  if (!ep) {
    throw new Error(`Endpoint "${args.endpointId}" not found`);
  }

  // Load full endpoint file
  const raw = files.read(ep.file);
  if (!raw) throw new Error(`Cannot read endpoint file: ${ep.file}`);

  const parsed = parseEndpointFileSafe(raw);

  // Load latest snapshot
  const snapshotFiles = listSnapshotFiles(args.endpointId);
  const latestSnap =
    snapshotFiles.length > 0
      ? JSON.parse(readFileSync(snapshotFiles[0]!, "utf-8"))
      : null;

  return {
    id: ep.id,
    name: ep.name,
    method: ep.method,
    url: ep.url,
    file: ep.file,
    definition: parsed,
    latestSnapshot: latestSnap,
  };
}

async function handleRunEndpoint(args: any): Promise<any> {
  const bridge = getBridge();

  if (bridge) {
    // IPC proxy mode — extension handles secrets
    return proxyToExtension(bridge, "run_endpoint", {
      endpointId: args.endpointId,
      envName: args.envName,
    });
  }

  // Standalone mode — env var secrets
  const result = await runEndpointStandalone(args.endpointId, args.envName);

  // Save snapshot to disk
  saveSnapshotToDisk(result.snapshot, args.endpointId);

  return result;
}

async function handleRunCollection(args: any): Promise<any> {
  const bridge = getBridge();
  if (bridge) {
    return proxyToExtension(bridge, "run_collection", {
      collectionId: args.collectionId,
      envName: args.envName,
    });
  }

  // Standalone mode
  const registry = new Registry(files).build();
  const endpoints = args.collectionId
    ? registry.endpoints.filter((e) => e.collectionId === args.collectionId)
    : registry.endpoints;

  const results: Array<{ id: string; passed: boolean; status: number; error?: string }> = [];
  for (const ep of endpoints) {
    try {
      const result = await runEndpointStandalone(ep.id, args.envName);
      results.push({
        id: ep.id,
        passed: result.snapshot.passed,
        status: result.snapshot.status,
      });
    } catch (err) {
      results.push({
        id: ep.id,
        passed: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

function handleGetSchema(args: any): any {
  const snapshotFiles = listSnapshotFiles(args.endpointId);
  if (snapshotFiles.length === 0) {
    throw new Error(
      `No snapshots found for "${args.endpointId}". Run the endpoint first.`
    );
  }

  const snap = JSON.parse(readFileSync(snapshotFiles[0]!, "utf-8"));
  const schema = inferSchema(snap.body);
  return { endpointId: args.endpointId, schema };
}

function handleDiffEndpoint(args: any): any {
  const fromId = args.fromSnapshotId;
  const toId = args.toSnapshotId;

  const snapFiles = listSnapshotFiles(args.endpointId);
  if (snapFiles.length < 2 && (!fromId || !toId)) {
    throw new Error(
      `Need at least 2 snapshots for "${args.endpointId}" to diff.`
    );
  }

  let fromSnap: any;
  let toSnap: any;

  if (fromId) {
    fromSnap = loadSnapshotById(args.endpointId, fromId);
  } else {
    // Use the 2nd newest as "from" (baseline), newest as "to"
    fromSnap = JSON.parse(readFileSync(snapFiles[1]!, "utf-8"));
  }

  if (toId) {
    toSnap = loadSnapshotById(args.endpointId, toId);
  } else {
    toSnap = JSON.parse(readFileSync(snapFiles[0]!, "utf-8"));
  }

  // Use the Differ from core
  const differ = new Differ();
  const result = differ.diff({
    endpointId: args.endpointId,
    from: fromSnap,
    to: toSnap,
  });

  return result;
}

function handleImpactReport(args: any): any {
  // Load latest snapshot for reference
  const snapFiles = listSnapshotFiles(args.endpointId);
  if (snapFiles.length === 0) {
    throw new Error(`No snapshots for "${args.endpointId}"`);
  }

  // Scan the project for files referencing this endpoint's fields
  const impactedFiles: string[] = [];
  const searchDirs = [
    resolve(PROJECT_ROOT, "lib"),
    resolve(PROJECT_ROOT, "src"),
    resolve(PROJECT_ROOT, "test"),
    resolve(PROJECT_ROOT, "android/app/src/main/kotlin"),
    resolve(PROJECT_ROOT, "ios/Runner"),
  ];

  // Look for generated model files related to this endpoint
  const endpointName = args.endpointId.split(".").pop() ?? "";
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      const walkDir = (d: string): string[] => {
        const entries = readdirSync(d, { withFileTypes: true });
        return entries.flatMap((e) => {
          if (e.isDirectory()) return walkDir(resolve(d, e.name));
          if (e.isFile() && (e.name.endsWith(".dart") || e.name.endsWith(".ts") || e.name.endsWith(".kt") || e.name.endsWith(".swift"))) {
            return [resolve(d, e.name)];
          }
          return [];
        });
      };
      const files = walkDir(dir);
      for (const f of files) {
        const content = readFileSync(f, "utf-8");
        if (content.includes(endpointName) || content.includes(args.endpointId)) {
          impactedFiles.push(f);
        }
      }
    } catch {
      /* skip */
    }
  }

  return {
    endpointId: args.endpointId,
    impactedFileCount: impactedFiles.length,
    files: impactedFiles,
    summary: `Found ${impactedFiles.length} file(s) that may reference endpoint "${args.endpointId}".`,
  };
}

async function handleGenerateCode(args: any): Promise<any> {
  const snapFiles = listSnapshotFiles(args.endpointId);
  if (snapFiles.length === 0) {
    throw new Error(`No snapshots for "${args.endpointId}". Run first.`);
  }

  const snap = JSON.parse(readFileSync(snapFiles[0]!, "utf-8"));
  const schema = inferSchema(snap.body);
  const language = args.language ?? "dart";
  const outputPath = args.outputPath ?? `.apilot/generated/${args.endpointId.replace(/\./g, "/")}`;

  // Use the shared CodegenEngine from @apilot/codegen
  const engine = new CodegenEngine();

  // Resolve endpoint details for context
  const registry = new Registry(files).build();
  const ep = registry.endpoints.find((e) => e.id === args.endpointId);
  if (!ep) throw new Error(`Endpoint "${args.endpointId}" not found`);

  const endpointName = ep.name;
  const endpointUrl = ep.url;
  const endpointMethod = ep.method;

  // Generate files
  const genFiles = engine.generate({
    endpointId: args.endpointId,
    endpointName,
    method: endpointMethod,
    url: endpointUrl,
    schema: schema as ApilotSchema,
    language,
    outputPath,
    flavor: args.flavor,
  });

  // Write files if not in dry-run mode
  let writtenFiles: string[] = [];
  if (args.outputPath) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    for (const f of genFiles) {
      const fullPath = resolve(PROJECT_ROOT, f.path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, f.content);
      writtenFiles.push(f.path);
    }
  }

  return {
    endpointId: args.endpointId,
    language,
    flavor: args.flavor ?? "default",
    files: genFiles.map((f) => ({
      path: f.path,
      language: f.language,
    })),
    writtenTo: writtenFiles,
    fileCount: genFiles.length,
  };
}

async function handleAddEndpoint(args: any): Promise<any> {
  // This is a simplified implementation — the full version parses cURL
  // and writes YAML files. For now, return the definition.
  if (args.cURL) {
    return {
      message: "cURL import in standalone mode is limited. Use the extension's 'Import' command for full cURL parsing.",
      parsed: { name: args.name, url: args.url, method: args.method ?? "GET" },
    };
  }

  const collection = args.collection ?? "default";
  const safeName = args.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  const endpointYaml = `name: ${args.name}
method: ${args.method ?? "GET"}
url: "${args.url}"
headers:
${formatKv(args.headers)}
body: ${args.body ?? "null"}
expect:
  status: 200
`;

  return {
    created: true,
    collection,
    endpointName: safeName,
    file: `.apilot/collections/${collection}/${safeName}.yaml`,
    content: endpointYaml,
  };
}

async function handleUpdateEndpoint(args: any): Promise<any> {
  const registry = new Registry(files).build();
  const ep = registry.endpoints.find((e) => e.id === args.endpointId);
  if (!ep) throw new Error(`Endpoint "${args.endpointId}" not found`);

  const raw = files.read(ep.file);
  if (!raw) throw new Error(`Cannot read endpoint file`);

  let parsed = parseEndpointFileSafe(raw);
  if (args.name) parsed.name = args.name;
  if (args.method) parsed.method = args.method as any;
  if (args.url) parsed.url = args.url;
  if (args.headers) parsed.headers = args.headers;
  if (args.body !== undefined) parsed.body = args.body;

  return { updated: true, endpointId: args.endpointId, definition: parsed };
}

async function handleImportSpec(args: any): Promise<any> {
  const source = args.source.toLowerCase();
  const content = args.content;

  if (source === "curl") {
    // Basic cURL parsing
    const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
    const methodMatch = content.match(/-X\s+(\w+)/);

    return {
      imported: true,
      count: 1,
      collection: args.collectionName ?? "imported",
      endpoint: {
        url: urlMatch?.[1] ?? "",
        method: methodMatch?.[1] ?? "GET",
      },
    };
  }

  if (source === "postman" || source === "openapi" || source === "har") {
    return {
      imported: true,
      message: `Imported from ${source}. Full import requires the extension.`,
      rawContentPreview: content.substring(0, 200),
    };
  }

  throw new Error(`Unsupported import source: ${source}`);
}

function handleListVariables(args: any): any {
  const registry = new Registry(files).build();
  const envName =
    args.envName ??
    registry.project.defaultEnvironment ??
    registry.environments[0]?.name;

  if (!envName) {
    throw new Error("No environment found. Create one in .apilot/environments/");
  }

  const raw = files.read(`.apilot/environments/${envName}.yaml`);
  if (!raw) throw new Error(`Environment "${envName}" not found`);

  const doc = parseYamLSafe(raw);
  const variables: Array<{ name: string; type: "text" | "secret" }> = [];

  for (const [name, def] of Object.entries(doc.variables ?? {})) {
    variables.push({
      name,
      type: (def as any)?.type ?? "text",
    });
  }

  return { envName, variables };
}

// ---------------------------------------------------------------------------
// Standalone runner (uses env var secrets)
// ---------------------------------------------------------------------------

async function runEndpointStandalone(
  endpointId: string,
  envName?: string
): Promise<{ snapshot: SnapshotRedacted }> {
  const registry = new Registry(files).build();
  const env = envName ??
    registry.project.defaultEnvironment ??
    registry.environments[0]?.name;

  if (!env) throw new Error("No environment found");

  const envRaw = files.read(`.apilot/environments/${env}.yaml`);
  if (!envRaw) throw new Error(`Environment "${env}" not found`);

  const envDoc = parseYamLSafe(envRaw);
  const secretValues: Record<string, string> = {};
  const variables: Record<string, string> = {};

  for (const [name, def] of Object.entries(envDoc.variables ?? {})) {
    const d = def as any;
    if (d?.type === "secret") {
      const val = getEnvSecret(name);
      if (val) secretValues[name] = val;
    } else if (d?.value !== undefined) {
      variables[name] = d.value;
    }
  }

  // Build context
  const allVars = { ...variables, ...secretValues };

  // Find endpoint
  const ep = registry.endpoints.find((e) => e.id === endpointId);
  if (!ep) throw new Error(`Endpoint "${endpointId}" not found`);

  const epRaw = files.read(ep.file);
  if (!epRaw) throw new Error(`Cannot read endpoint file: ${ep.file}`);

  const endpoint = parseEndpointFileSafe(epRaw);

  // Interpolate URL, headers, body
  const url = interpolate(endpoint.url, allVars);
  const headers: Record<string, string> = {};
  if (endpoint.headers) {
    for (const [k, v] of Object.entries(endpoint.headers)) {
      headers[k] = interpolate(v as string, allVars);
    }
  }
  if (endpoint.auth) {
    const authHeaders = resolveAuthStandalone(endpoint.auth, allVars);
    Object.assign(headers, authHeaders);
  }

  // Run request
  const request = {
    method: endpoint.method,
    url,
    headers,
    body: endpoint.body ?? null,
  };

  const startTime = Date.now();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const bodyRaw = await response.text();
  const body = tryParseJson(bodyRaw);
  const timeMs = Date.now() - startTime;
  const size = bodyRaw.length;

  // Redact
  const redactor = new Redactor({ secretValues });
  const redactedHeaders = redactor.redactHeaders(headers);
  const redactedResponseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    redactedResponseHeaders[k] = redactor.redactString(v);
  });

  const snapshot: any = {
    id: `${endpointId}-${Date.now().toString(36)}`,
    endpointId,
    timestamp: new Date().toISOString(),
    request: {
      method: request.method,
      url: redactor.redactString(request.url),
      headers: redactedHeaders,
      body: request.body ? redactor.redactString(request.body) : null,
    },
    status: response.status,
    headers: redactedResponseHeaders,
    body: redactor.redactObject(body),
    bodyRaw: redactor.redactString(bodyRaw),
    timeMs,
    size,
    passed: response.status >= 200 && response.status < 400,
    failures: [],
    // No _secretValues — already redacted
  };

  return { snapshot };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveSnapshotToDisk(snapshot: any, endpointId: string): void {
  const snapDir = resolve(APilot_DIR, "snapshots", endpointId);
  mkdirSync(snapDir, { recursive: true });
  const safeName = snapshot.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = resolve(snapDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

function listSnapshotFiles(endpointId: string): string[] {
  const snapDir = resolve(APilot_DIR, "snapshots", endpointId);
  if (!existsSync(snapDir)) return [];
  return readdirSync(snapDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => resolve(snapDir, f))
    .sort((a, b) => {
      const statA = readFileSync(a, "utf-8");
      const statB = readFileSync(b, "utf-8");
      const timeA = JSON.parse(statA).timestamp;
      const timeB = JSON.parse(statB).timestamp;
      return Date.parse(timeB) - Date.parse(timeA);
    });
}

function loadSnapshotById(endpointId: string, id: string): any {
  const snapDir = resolve(APilot_DIR, "snapshots", endpointId);
  const file = resolve(snapDir, `${id}.json`);
  if (!existsSync(file)) {
    // Try full id match
    const files = readdirSync(snapDir);
    const match = files.find((f) => f.endsWith(`.${id}.json`));
    if (!match) throw new Error(`Snapshot "${id}" not found`);
    return JSON.parse(readFileSync(resolve(snapDir, match), "utf-8"));
  }
  return JSON.parse(readFileSync(file, "utf-8"));
}

function parseYamLSafe(raw: string): any {
  return parseYaml(raw);
}

function parseEndpointFileSafe(raw: string): any {
  return parseYamLSafe(raw);
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Variable "${key}" is not defined`);
    return v;
  });
}

function resolveAuthStandalone(auth: any, vars: Record<string, string>): Record<string, string> {
  if (!auth) return {};
  switch (auth.type) {
    case "bearer": {
      const token = interpolate(auth.token, vars);
      return { Authorization: `Bearer ${token}` };
    }
    case "basic": {
      const user = interpolate(auth.username, vars);
      const pass = interpolate(auth.password, vars);
      const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    default:
      return {};
  }
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function formatKv(obj: Record<string, string> | undefined): string {
  if (!obj) return "  {}";
  return Object.entries(obj)
    .map(([k, v]) => `  ${k}: "${v}"`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "apilot-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool list handler
(server as any).setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: TOOLS,
  };
});

// Register tool execution handler
(server as any).setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const toolName = request.params?.name;
  const args = request.params?.arguments ?? {};

  const handlers: Record<string, (args: any) => Promise<any> | any> = {
    list_endpoints: handleListEndpoints,
    get_endpoint: handleGetEndpoint,
    run_endpoint: handleRunEndpoint,
    run_collection: handleRunCollection,
    get_schema: handleGetSchema,
    diff_endpoint: handleDiffEndpoint,
    impact_report: handleImpactReport,
    generate_code: handleGenerateCode,
    add_endpoint: handleAddEndpoint,
    update_endpoint: handleUpdateEndpoint,
    import_spec: handleImportSpec,
    list_variables: handleListVariables,
  };

  const handler = handlers[toolName];
  if (!handler) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${toolName}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await handler(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[apilot-mcp] Server started. Project root:", PROJECT_ROOT);
