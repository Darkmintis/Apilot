/**
 * The Apilot tool table. Every action the GUI offers has a tool here, and the
 * same `callTool` runs in two places:
 *  - the standalone MCP server (secrets from APILOT_SECRET_<name>)
 *  - the editor extension via the local bridge (secrets from the OS keychain)
 *
 * The AI can do everything a user can except read or enter secret values.
 */

import { importSpec, schemaToJsonSchema, type EndpointFile, type Workspace } from "@apilot/core";
import { LANGUAGES, generate, writeGenerated } from "@apilot/codegen";

type Json = Record<string, unknown>;

const s = (description: string) => ({ type: "string", description });
const endpointId = s("Endpoint id, e.g. 'orders.list' (see list_endpoints).");
const env = s("Environment name, e.g. 'dev'. Defaults to the project's default environment.");
const snapshotId = (which: string) => s(`Snapshot id (see list_snapshots). Defaults to ${which}.`);

const endpointFields = {
  name: s("Display name."),
  method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
  url: s("URL; use {{variables}}, e.g. '{{baseUrl}}/orders/{{orderId}}'."),
  query: { type: "object", additionalProperties: { type: "string" }, description: "Query parameters." },
  headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers. Never put secret values here — use {{secretVar}}." },
  body: { description: "Request body: a JSON object/array (sent as JSON) or a raw string." },
  auth: {
    type: "object",
    description: "Auth: {type:'bearer',token:'{{authToken}}'} | {type:'basic',username,password} | {type:'apiKey',in:'header'|'query',name,key} | {type:'custom',headers}. Reference secrets with {{name}}.",
  },
  expect: { type: "object", description: "Assertions, e.g. {status: 200}." },
  after: { type: "array", description: "Chaining, e.g. [{set: {orderId: '$.data[0].id'}}] captures values for later requests." },
  label: s("Optional label for the revision this change creates, e.g. 'added pagination'."),
};

export const TOOLS = [
  { name: "list_endpoints", description: "List collections, endpoints (id, method, url), and environments. Call this first.", inputSchema: { type: "object", properties: { collectionId: s("Optional collection filter.") } } },
  { name: "get_endpoint", description: "Full endpoint definition plus its latest real (redacted) response. Use it instead of guessing request or response shapes.", inputSchema: { type: "object", properties: { endpointId }, required: ["endpointId"] } },
  { name: "add_endpoint", description: "Create an endpoint file in .apilot/collections/<collection>/.", inputSchema: { type: "object", properties: { collection: s("Collection folder, e.g. 'orders'."), ...endpointFields }, required: ["name", "method", "url"] } },
  { name: "update_endpoint", description: "Change an endpoint. Only provided fields change; pass null to remove a field. Every change is recorded as a revision.", inputSchema: { type: "object", properties: { endpointId, ...endpointFields }, required: ["endpointId"] } },
  { name: "delete_endpoint", description: "Delete an endpoint file (its history and snapshots are kept).", inputSchema: { type: "object", properties: { endpointId }, required: ["endpointId"] } },
  { name: "run_endpoint", description: "Send the real request and return the redacted response, plus a diff against the baseline when the shape changed.", inputSchema: { type: "object", properties: { endpointId, env }, required: ["endpointId"] } },
  { name: "run_collection", description: "Run a collection (or everything) in order, with chaining. Returns pass/fail and breaking-change flags per endpoint.", inputSchema: { type: "object", properties: { collectionId: s("Collection to run; omit for all."), env } } },
  { name: "list_snapshots", description: "Saved responses for an endpoint, newest first (the baseline is flagged).", inputSchema: { type: "object", properties: { endpointId }, required: ["endpointId"] } },
  { name: "get_snapshot", description: "One saved (redacted) request/response.", inputSchema: { type: "object", properties: { endpointId, snapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "set_baseline", description: "Accept a response as the contract that future runs are compared against.", inputSchema: { type: "object", properties: { endpointId, snapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "delete_snapshot", description: "Delete a saved response (not the baseline).", inputSchema: { type: "object", properties: { endpointId, snapshotId: s("Snapshot id (see list_snapshots).") }, required: ["endpointId", "snapshotId"] } },
  { name: "diff_endpoint", description: "Classified response changes (breaking / warning / non-breaking / info). Default: baseline → latest.", inputSchema: { type: "object", properties: { endpointId, fromSnapshotId: snapshotId("the baseline"), toSnapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "impact_report", description: "Files and lines in the codebase that use fields the diff marks breaking or warning. Fix only these.", inputSchema: { type: "object", properties: { endpointId, fromSnapshotId: snapshotId("the baseline"), toSnapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "get_schema", description: "Response schema learned from every successful response: types, required and nullable fields, enums. Use before writing models.", inputSchema: { type: "object", properties: { endpointId }, required: ["endpointId"] } },
  { name: "generate_code", description: `Generate typed models + API call from real responses and write them (hand-written files are never overwritten). Languages: ${LANGUAGES.join(", ")}.`, inputSchema: { type: "object", properties: { endpointId, language: { type: "string", enum: [...LANGUAGES] }, outDir: s("Output dir relative to the project. Defaults to apilot.yaml codegen settings."), flavor: s("dart: 'freezed' (default) or 'plain'."), write: { type: "boolean", description: "Write files (default true). false returns the code only." } }, required: ["endpointId", "language"] } },
  { name: "list_revisions", description: "Version history of an endpoint's request definition (v1, v2, …) with change summaries.", inputSchema: { type: "object", properties: { endpointId }, required: ["endpointId"] } },
  { name: "diff_revisions", description: "What changed in the request definition between two revisions (default: previous → latest).", inputSchema: { type: "object", properties: { endpointId, from: { type: "number" }, to: { type: "number" } }, required: ["endpointId"] } },
  { name: "restore_revision", description: "Restore an endpoint definition to an earlier revision (recorded as a new revision).", inputSchema: { type: "object", properties: { endpointId, revision: { type: "number" } }, required: ["endpointId", "revision"] } },
  { name: "import_spec", description: "Import endpoints from a cURL command, Postman v2 collection, or OpenAPI/Swagger document (JSON or YAML). Credentials become secret variables, never file contents.", inputSchema: { type: "object", properties: { source: { type: "string", enum: ["curl", "postman", "openapi"] }, content: s("The cURL command or document text."), collection: s("Target collection (optional)."), env }, required: ["source", "content"] } },
  { name: "list_variables", description: "Variables in an environment: text values, and for secrets only whether a value is set. Secret values are never returned.", inputSchema: { type: "object", properties: { env } } },
  { name: "set_variable", description: "Set a text variable, or declare a secret variable (the user enters secret values in the Apilot panel).", inputSchema: { type: "object", properties: { env, name: s("Variable name."), type: { type: "string", enum: ["text", "secret"] }, value: s("Text value. Not allowed for secrets.") }, required: ["name"] } },
  { name: "delete_variable", description: "Remove a variable from an environment.", inputSchema: { type: "object", properties: { env, name: s("Variable name.") }, required: ["name"] } },
  { name: "create_environment", description: "Create an environment, optionally copying variables from another.", inputSchema: { type: "object", properties: { name: s("e.g. 'staging'."), copyFrom: s("Existing environment to copy.") }, required: ["name"] } },
  { name: "init_project", description: "Create a starter .apilot/ folder in the project (safe if it already exists).", inputSchema: { type: "object", properties: { name: s("Project name.") } } },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

const MAX_BODY_CHARS = 60_000;

/** Keep responses readable for the model; the full body stays in the snapshot file. */
function clip(body: unknown): unknown {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text || text.length <= MAX_BODY_CHARS) return body;
  return { truncated: true, note: `Body is ${text.length} chars; showing the first ${MAX_BODY_CHARS}. Use get_schema for the full shape.`, preview: text.slice(0, MAX_BODY_CHARS) };
}

function pickEndpoint(args: Json): Partial<EndpointFile> {
  const out: Json = {};
  for (const k of ["name", "method", "url", "query", "headers", "body", "auth", "expect", "after"]) if (k in args) out[k] = args[k] ?? undefined;
  return out as Partial<EndpointFile>;
}

export async function callTool(ws: Workspace, name: string, args: Json = {}): Promise<unknown> {
  const id = args.endpointId as string;
  if (name !== "init_project" && !ws.exists()) {
    throw new Error("No Apilot project here. Call init_project first, or open a folder that contains .apilot/apilot.yaml.");
  }
  switch (name as ToolName) {
    case "list_endpoints": {
      const reg = ws.registry();
      const filter = args.collectionId as string | undefined;
      return {
        project: reg.project.name,
        defaultEnvironment: reg.project.defaultEnvironment,
        environments: reg.environments.map((e) => e.name),
        collections: reg.collections.map((c) => ({ id: c.id, name: c.name })),
        endpoints: reg.endpoints
          .filter((e) => !filter || e.collectionId === filter || e.collectionId.startsWith(`${filter}/`))
          .map((e) => ({ id: e.id, name: e.name, method: e.method, url: e.url, file: e.file, snapshots: ws.store.list(e.id).length })),
      };
    }
    case "get_endpoint": {
      const { entry, definition } = ws.endpoint(id);
      const latest = ws.store.latest(id);
      return {
        id, file: entry.file, definition,
        revision: ws.revisions(id)[0]?.revision,
        latestResponse: latest ? { snapshotId: latest.id, timestamp: latest.timestamp, status: latest.status, headers: latest.headers, body: clip(latest.body) } : null,
        hint: latest ? undefined : "No response saved yet — call run_endpoint.",
      };
    }
    case "add_endpoint": {
      const def = pickEndpoint(args) as EndpointFile;
      return ws.saveEndpoint({ ...def, collection: args.collection as string | undefined, label: args.label as string | undefined });
    }
    case "update_endpoint": {
      const { definition } = ws.endpoint(id);
      return ws.saveEndpoint({ ...definition, ...pickEndpoint(args), id, label: args.label as string | undefined });
    }
    case "delete_endpoint":
      ws.deleteEndpoint(id);
      return { deleted: id };
    case "run_endpoint": {
      const r = await ws.run(id, args.env as string | undefined);
      return {
        endpointId: id, env: r.env, snapshotId: r.snapshot.id,
        request: { method: r.snapshot.request.method, url: r.snapshot.request.url },
        status: r.snapshot.status, passed: r.snapshot.passed, failures: r.snapshot.failures, timeMs: r.snapshot.timeMs,
        headers: r.snapshot.headers, body: clip(r.snapshot.body),
        captured: Object.keys(r.captured).length ? r.captured : undefined,
        diffAgainstBaseline: r.diff && r.diff.changes.length ? { breaking: r.diff.breaking, summary: r.diff.summary, changes: r.diff.changes } : undefined,
      };
    }
    case "run_collection":
      return ws.runAll(args.collectionId as string | undefined, args.env as string | undefined);
    case "list_snapshots":
      return ws.snapshots(id);
    case "get_snapshot": {
      const snap = ws.snapshot(id, args.snapshotId as string | undefined);
      return { ...snap, body: clip(snap.body) };
    }
    case "set_baseline":
      return { endpointId: id, baseline: ws.setBaseline(id, args.snapshotId as string | undefined) };
    case "delete_snapshot":
      ws.deleteSnapshot(id, args.snapshotId as string);
      return { deleted: args.snapshotId };
    case "diff_endpoint":
      return ws.diff(id, args.fromSnapshotId as string | undefined, args.toSnapshotId as string | undefined);
    case "impact_report": {
      const diff = ws.diff(id, args.fromSnapshotId as string | undefined, args.toSnapshotId as string | undefined);
      const { fields, matches } = ws.impact(id, diff);
      return { endpointId: id, breaking: diff.breaking, changedFields: fields, matches, summary: matches.length ? `${new Set(matches.map((m) => m.file)).size} file(s) use changed fields.` : "No code references to changed fields found." };
    }
    case "get_schema": {
      const schema = ws.schema(id);
      return { endpointId: id, samples: ws.store.list(id).filter((s) => s.passed).length, schema: schemaToJsonSchema(schema) };
    }
    case "generate_code": {
      const files = generate(ws, id, args.language as string, { outDir: args.outDir as string | undefined, flavor: args.flavor as string | undefined });
      if (args.write === false) return { files };
      return { ...writeGenerated(ws.root, files), note: "Files marked GENERATED BY APILOT are regenerated; hand-written files are skipped." };
    }
    case "list_revisions":
      return ws.revisions(id).map(({ definition, ...rest }) => ({ ...rest, method: definition.method, url: definition.url }));
    case "diff_revisions":
      return ws.diffRevisions(id, args.from as number | undefined, args.to as number | undefined);
    case "restore_revision":
      return { endpointId: id, revision: ws.restoreRevision(id, args.revision as number) };
    case "import_spec":
      return importSpec(ws, args.source as "curl" | "postman" | "openapi", args.content as string, args.collection as string | undefined, args.env as string | undefined);
    case "list_variables": {
      const envName = ws.envName(args.env as string | undefined);
      return { env: envName, variables: await ws.variables(envName) };
    }
    case "set_variable": {
      const type = (args.type as "text" | "secret" | undefined) ?? "text";
      if (type === "secret" && args.value !== undefined) throw new Error("Secret values can't be set by tools. Declare the secret, then ask the user to enter it in the Apilot panel → Environments.");
      const envName = ws.envName(args.env as string | undefined);
      await ws.setVariable(envName, args.name as string, type, type === "text" ? String(args.value ?? "") : undefined);
      return { env: envName, name: args.name, type };
    }
    case "delete_variable": {
      const envName = ws.envName(args.env as string | undefined);
      await ws.deleteVariable(envName, args.name as string);
      return { env: envName, deleted: args.name };
    }
    case "create_environment":
      ws.createEnvironment(args.name as string, args.copyFrom as string | undefined);
      return { created: args.name };
    case "init_project":
      ws.init((args.name as string | undefined) ?? "my-api");
      return { initialized: ws.apilotDir };
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}
