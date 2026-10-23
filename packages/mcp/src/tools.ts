/**
 * The Apilot tool table. Every action the GUI offers has a tool here, and the
 * same `callTool` runs in three places:
 *  - the standalone MCP server (secrets from APILOT_SECRET_<name>)
 *  - the editor extension via the local bridge (secrets from the OS keychain)
 *  - the CLI
 *
 * The AI can do everything a user can except read or enter secret values.
 *
 * A workspace can hold several Apilot projects. Every endpoint tool takes an
 * optional `project` so the AI can say which one it means; when the endpoint
 * id is unique across the workspace, `project` can be left out.
 */

import {
  importSpec,
  isToolContext,
  schemaToJsonSchema,
  singleProjectContext,
  type EndpointFile,
  type ToolContext,
  type Workspace,
} from "@apilot/core";
import { LANGUAGES, generate, writeGenerated } from "@apilot/codegen";

type Json = Record<string, unknown>;

const s = (description: string) => ({ type: "string", description });
const endpointId = s("Endpoint id, e.g. 'orders.list' (see list_endpoints).");
const env = s("Environment name, e.g. 'dev'. Defaults to the project's default environment.");
const snapshotId = (which: string) => s(`Snapshot id (see list_snapshots). Defaults to ${which}.`);
const project = s(
  "Apilot project id, e.g. 'services/api' (see list_endpoints). Omit when the endpoint id is unique in this workspace."
);

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
  { name: "list_endpoints", description: "List projects, collections, endpoints (id, project, method, url), and environments. Call this first.", inputSchema: { type: "object", properties: { collectionId: s("Optional collection filter."), project } } },
  { name: "get_endpoint", description: "Full endpoint definition plus its latest real (redacted) response. Use it instead of guessing request or response shapes.", inputSchema: { type: "object", properties: { endpointId, project }, required: ["endpointId"] } },
  { name: "add_endpoint", description: "Create an endpoint file in .apilot/collections/<collection>/ of a project.", inputSchema: { type: "object", properties: { collection: s("Collection folder, e.g. 'orders'."), project, ...endpointFields }, required: ["name", "method", "url"] } },
  { name: "update_endpoint", description: "Change an endpoint. Only provided fields change; pass null to remove a field. Every change is recorded as a revision.", inputSchema: { type: "object", properties: { endpointId, project, ...endpointFields }, required: ["endpointId"] } },
  { name: "delete_endpoint", description: "Delete an endpoint file (its history and snapshots are kept).", inputSchema: { type: "object", properties: { endpointId, project }, required: ["endpointId"] } },
  { name: "run_endpoint", description: "Send the real request and return the redacted response, plus a diff against the baseline when the shape changed.", inputSchema: { type: "object", properties: { endpointId, project, env }, required: ["endpointId"] } },
  { name: "run_collection", description: "Run a collection (or everything) in order, with chaining. Returns pass/fail and breaking-change flags per endpoint.", inputSchema: { type: "object", properties: { collectionId: s("Collection to run; omit for all."), project, env } } },
  { name: "list_snapshots", description: "Saved responses for an endpoint, newest first (the baseline is flagged).", inputSchema: { type: "object", properties: { endpointId, project }, required: ["endpointId"] } },
  { name: "get_snapshot", description: "One saved (redacted) request/response.", inputSchema: { type: "object", properties: { endpointId, project, snapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "set_baseline", description: "Accept a response as the contract that future runs are compared against.", inputSchema: { type: "object", properties: { endpointId, project, snapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "delete_snapshot", description: "Delete a saved response (not the baseline).", inputSchema: { type: "object", properties: { endpointId, project, snapshotId: s("Snapshot id (see list_snapshots).") }, required: ["endpointId", "snapshotId"] } },
  { name: "diff_endpoint", description: "Classified response changes (breaking / warning / non-breaking / info). Default: baseline → latest.", inputSchema: { type: "object", properties: { endpointId, project, fromSnapshotId: snapshotId("the baseline"), toSnapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "impact_report", description: "Files and lines in the codebase that use fields the diff marks breaking or warning. Fix only these.", inputSchema: { type: "object", properties: { endpointId, project, fromSnapshotId: snapshotId("the baseline"), toSnapshotId: snapshotId("the latest") }, required: ["endpointId"] } },
  { name: "get_schema", description: "Response schema learned from every successful response: types, required and nullable fields, enums. Use before writing models.", inputSchema: { type: "object", properties: { endpointId, project }, required: ["endpointId"] } },
  { name: "generate_code", description: `Generate typed models + API call from real responses and write them (hand-written files are never overwritten). Languages: ${LANGUAGES.join(", ")}.`, inputSchema: { type: "object", properties: { endpointId, project, language: { type: "string", enum: [...LANGUAGES] }, outDir: s("Output dir relative to the project. Defaults to apilot.yaml codegen settings."), flavor: s("dart: 'freezed' (default) or 'plain'."), write: { type: "boolean", description: "Write files (default true). false returns the code only." } }, required: ["endpointId", "language"] } },
  { name: "list_revisions", description: "Version history of an endpoint's request definition (v1, v2, …) with change summaries.", inputSchema: { type: "object", properties: { endpointId, project }, required: ["endpointId"] } },
  { name: "diff_revisions", description: "What changed in the request definition between two revisions (default: previous → latest).", inputSchema: { type: "object", properties: { endpointId, project, from: { type: "number" }, to: { type: "number" } }, required: ["endpointId"] } },
  { name: "restore_revision", description: "Restore an endpoint definition to an earlier revision (recorded as a new revision).", inputSchema: { type: "object", properties: { endpointId, project, revision: { type: "number" } }, required: ["endpointId", "revision"] } },
  { name: "import_spec", description: "Import endpoints from a cURL command, Postman v2 collection, or OpenAPI/Swagger document (JSON or YAML). Credentials become secret variables, never file contents.", inputSchema: { type: "object", properties: { source: { type: "string", enum: ["curl", "postman", "openapi"] }, content: s("The cURL command or document text."), collection: s("Target collection (optional)."), project, env }, required: ["source", "content"] } },
  { name: "list_variables", description: "Variables in an environment: text values, and for secrets only whether a value is set. Secret values are never returned.", inputSchema: { type: "object", properties: { project, env } } },
  { name: "set_variable", description: "Set a text variable, or declare a secret variable (the user enters secret values in the Apilot panel).", inputSchema: { type: "object", properties: { project, env, name: s("Variable name."), type: { type: "string", enum: ["text", "secret"] }, value: s("Text value. Not allowed for secrets.") }, required: ["name"] } },
  { name: "delete_variable", description: "Remove a variable from an environment.", inputSchema: { type: "object", properties: { project, env, name: s("Variable name.") }, required: ["name"] } },
  { name: "create_environment", description: "Create an environment, optionally copying variables from another.", inputSchema: { type: "object", properties: { project, name: s("e.g. 'staging'."), copyFrom: s("Existing environment to copy.") }, required: ["name"] } },
  { name: "init_project", description: "Create a starter .apilot/ folder in a project (safe if it already exists).", inputSchema: { type: "object", properties: { project, name: s("Project name.") } } },
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

/**
 * Run a tool.
 *
 * `ctx` is either a `Workspace` (one project) or a `ToolContext` (a hub of
 * every project in the workspace). Both work; the hub is what the editor and
 * the MCP server use.
 */
export async function callTool(ctx: Workspace | ToolContext, name: string, args: Json = {}): Promise<unknown> {
  const c: ToolContext = isToolContext(ctx) ? ctx : singleProjectContext(ctx);
  const projectId = args.project as string | undefined;
  const id = args.endpointId as string;

  if (name !== "init_project" && !c.exists()) {
    throw new Error("No Apilot project here. Call init_project first, or open a folder that contains .apilot/apilot.yaml.");
  }

  /** Resolve the endpoint and hand back its workspace. */
  const endpoint = () => c.resolveEndpoint(id, projectId);
  /** The workspace a project-scoped command applies to. */
  const ws = (): Workspace => c.workspace(projectId);

  switch (name as ToolName) {
    case "list_endpoints": {
      const filter = args.collectionId as string | undefined;
      const entries = c
        .listEndpoints(projectId)
        .filter(({ endpoint }) => !filter || endpoint.collectionId === filter || endpoint.collectionId.startsWith(`${filter}/`));
      const projects = c.projects.map((p) => {
        const reg = c.workspace(p.id).registry();
        return {
          id: p.id,
          name: p.name,
          root: p.root,
          hasApilot: p.hasApilot,
          defaultEnvironment: reg.project.defaultEnvironment,
          environments: reg.environments.map((e) => e.name),
          endpointCount: reg.endpoints.length,
        };
      });
      const def = c.workspace(projectId).registry().project;
      const collections = c.projects.flatMap((p) =>
        c.workspace(p.id).registry().collections.map((col) => ({ id: col.id, name: col.name, project: p.id }))
      );
      return {
        project: def.name,
        defaultEnvironment: def.defaultEnvironment,
        environments: [...new Set(projects.flatMap((p) => p.environments))],
        projects,
        collections,
        endpoints: entries.map(({ project, endpoint }) => ({
          id: endpoint.id,
          project: project.id,
          name: endpoint.name,
          method: endpoint.method,
          url: endpoint.url,
          file: endpoint.file,
          snapshots: c.workspace(project.id).store.list(endpoint.id).length,
        })),
      };
    }
    case "get_endpoint": {
      const { project, ws: workspace, endpointId: eid } = endpoint();
      const { entry, definition } = workspace.endpoint(eid);
      const latest = workspace.store.latest(eid);
      return {
        id: eid,
        project: project.id,
        file: entry.file,
        definition,
        revision: workspace.revisions(eid)[0]?.revision,
        latestResponse: latest ? { snapshotId: latest.id, timestamp: latest.timestamp, status: latest.status, headers: latest.headers, body: clip(latest.body) } : null,
        hint: latest ? undefined : "No response saved yet — call run_endpoint.",
      };
    }
    case "add_endpoint": {
      const def = pickEndpoint(args) as EndpointFile;
      const workspace = c.ensureProject(projectId);
      return workspace.saveEndpoint({ ...def, collection: args.collection as string | undefined, label: args.label as string | undefined });
    }
    case "update_endpoint": {
      const { ws: workspace, endpointId: eid } = endpoint();
      const { definition } = workspace.endpoint(eid);
      return workspace.saveEndpoint({ ...definition, ...pickEndpoint(args), id: eid, label: args.label as string | undefined });
    }
    case "delete_endpoint": {
      const { ws: workspace, endpointId: eid } = endpoint();
      workspace.deleteEndpoint(eid);
      return { deleted: eid };
    }
    case "run_endpoint": {
      const { project, ws: workspace, endpointId: eid } = endpoint();
      const r = await workspace.run(eid, args.env as string | undefined);
      return {
        endpointId: eid,
        project: project.id,
        env: r.env,
        snapshotId: r.snapshot.id,
        request: { method: r.snapshot.request.method, url: r.snapshot.request.url },
        status: r.snapshot.status,
        passed: r.snapshot.passed,
        failures: r.snapshot.failures,
        timeMs: r.snapshot.timeMs,
        headers: r.snapshot.headers,
        body: clip(r.snapshot.body),
        captured: Object.keys(r.captured).length ? r.captured : undefined,
        diffAgainstBaseline: r.diff && r.diff.changes.length ? { breaking: r.diff.breaking, summary: r.diff.summary, changes: r.diff.changes } : undefined,
      };
    }
    case "run_collection":
      return ws().runAll(args.collectionId as string | undefined, args.env as string | undefined);
    case "list_snapshots": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return workspace.snapshots(eid);
    }
    case "get_snapshot": {
      const { ws: workspace, endpointId: eid } = endpoint();
      const snap = workspace.snapshot(eid, args.snapshotId as string | undefined);
      return { ...snap, body: clip(snap.body) };
    }
    case "set_baseline": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return { endpointId: eid, baseline: workspace.setBaseline(eid, args.snapshotId as string | undefined) };
    }
    case "delete_snapshot": {
      const { ws: workspace, endpointId: eid } = endpoint();
      workspace.deleteSnapshot(eid, args.snapshotId as string);
      return { deleted: args.snapshotId };
    }
    case "diff_endpoint": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return workspace.diff(eid, args.fromSnapshotId as string | undefined, args.toSnapshotId as string | undefined);
    }
    case "impact_report": {
      const { ws: workspace, endpointId: eid } = endpoint();
      const diff = workspace.diff(eid, args.fromSnapshotId as string | undefined, args.toSnapshotId as string | undefined);
      const { fields, matches } = workspace.impact(eid, diff);
      return { endpointId: eid, breaking: diff.breaking, changedFields: fields, matches, summary: matches.length ? `${new Set(matches.map((m) => m.file)).size} file(s) use changed fields.` : "No code references to changed fields found." };
    }
    case "get_schema": {
      const { ws: workspace, endpointId: eid } = endpoint();
      const schema = workspace.schema(eid);
      return { endpointId: eid, samples: workspace.store.list(eid).filter((s) => s.passed).length, schema: schemaToJsonSchema(schema) };
    }
    case "generate_code": {
      const { ws: workspace, endpointId: eid } = endpoint();
      const files = generate(workspace, eid, args.language as string, { outDir: args.outDir as string | undefined, flavor: args.flavor as string | undefined });
      if (args.write === false) return { files };
      return { ...writeGenerated(workspace.root, files), note: "Files marked GENERATED BY APILOT are regenerated; hand-written files are skipped." };
    }
    case "list_revisions": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return workspace.revisions(eid).map(({ definition, ...rest }) => ({ ...rest, method: definition.method, url: definition.url }));
    }
    case "diff_revisions": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return workspace.diffRevisions(eid, args.from as number | undefined, args.to as number | undefined);
    }
    case "restore_revision": {
      const { ws: workspace, endpointId: eid } = endpoint();
      return { endpointId: eid, revision: workspace.restoreRevision(eid, args.revision as number) };
    }
    case "import_spec":
      return importSpec(c.ensureProject(projectId), args.source as "curl" | "postman" | "openapi", args.content as string, args.collection as string | undefined, args.env as string | undefined);
    case "list_variables": {
      const workspace = ws();
      const envName = workspace.envName(args.env as string | undefined);
      return { env: envName, variables: await workspace.variables(envName) };
    }
    case "set_variable": {
      const type = (args.type as "text" | "secret" | undefined) ?? "text";
      if (type === "secret" && args.value !== undefined) throw new Error("Secret values can't be set by tools. Declare the secret, then ask the user to enter it in the Apilot panel → Environments.");
      const workspace = ws();
      const envName = workspace.envName(args.env as string | undefined);
      await workspace.setVariable(envName, args.name as string, type, type === "text" ? String(args.value ?? "") : undefined);
      return { env: envName, name: args.name, type };
    }
    case "delete_variable": {
      const workspace = ws();
      const envName = workspace.envName(args.env as string | undefined);
      await workspace.deleteVariable(envName, args.name as string);
      return { env: envName, deleted: args.name };
    }
    case "create_environment": {
      ws().createEnvironment(args.name as string, args.copyFrom as string | undefined);
      return { created: args.name };
    }
    case "init_project":
      return c.initProject((args.name as string | undefined) ?? "my-api", projectId);
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}
