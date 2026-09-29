/**
 * Workspace — every action a user (or their AI) can take on an Apilot
 * project. The extension GUI, the MCP server, and the CLI all call this, so
 * the three surfaces can never drift apart.
 *
 * Secrets never touch disk: they come from a SecretProvider (the OS keychain
 * in the editor, environment variables in CI) and are redacted before any
 * snapshot is written or any result is returned.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type {
  ApilotProject,
  ApilotSchema,
  DiffResult,
  EndpointEntry,
  EndpointFile,
  EnvironmentFile,
  FolderFile,
  ProjectRegistry,
  Revision,
  RevisionChange,
  SnapshotMeta,
  SnapshotRedacted,
  Variable,
} from "./types.js";
import { NodeFileResolver, Registry, parseEndpointFile, parseEnvironmentFile } from "./file-format.js";
import { interpolate, referencedVars, VariableError } from "./variables.js";
import { Redactor } from "./redaction.js";
import { RequestRunner } from "./runner.js";
import { SnapshotStore } from "./snapshots.js";
import { Differ } from "./differ.js";
import { SchemaBuilder, inferSchema } from "./schema.js";

export interface SecretProvider {
  get(env: string, name: string): Promise<string | undefined>;
  /** Store a value (editor keychain only; CI providers omit this). */
  set?(env: string, name: string, value: string): Promise<void>;
  /** Ask the user for missing values, e.g. with a password prompt. */
  prompt?(env: string, names: string[]): Promise<void>;
}

/** CI / standalone secrets: `APILOT_SECRET_<name>` (exact or upper-case). */
export const envSecrets: SecretProvider = {
  async get(_env, name) {
    return process.env[`APILOT_SECRET_${name}`] ?? process.env[`APILOT_SECRET_${name.toUpperCase()}`];
  },
};

export interface WorkspaceOptions {
  secrets?: SecretProvider;
  timeout?: number;
  retention?: number;
}

export interface EndpointInput extends EndpointFile {
  /** existing endpoint id to update; omit to create */
  id?: string;
  /** collection folder for new endpoints, e.g. "orders" or "orders/admin" */
  collection?: string;
  /** label for the revision this save creates */
  label?: string;
}

export interface VariableInfo {
  name: string;
  type: "text" | "secret";
  /** text values only — secret values are never returned */
  value?: string;
  /** secrets only: whether a value is available right now */
  hasValue?: boolean;
}

export interface RunOutcome {
  endpointId: string;
  env: string;
  snapshot: SnapshotRedacted;
  /** diff against the baseline, when one exists and differs from this run */
  diff?: DiffResult;
  /** variables captured by `after` steps (values of secret-looking names are redacted) */
  captured: Record<string, string>;
}

export interface RunAllItem {
  endpointId: string;
  name: string;
  method: string;
  status?: number;
  timeMs?: number;
  passed: boolean;
  breaking: boolean;
  summary?: DiffResult["summary"];
  error?: string;
}

export interface ImpactMatch {
  file: string;
  line: number;
  field: string;
  text: string;
}

const CODE_EXT = /\.(dart|ts|tsx|js|jsx|mjs|kt|swift|java|vue|svelte)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".dart_tool", "build", "dist", "out", ".next", "Pods", ".gradle", ".apilot", "coverage"]);

export class Workspace {
  readonly apilotDir: string;
  readonly store: SnapshotStore;
  private readonly secrets: SecretProvider;
  private readonly runner: RequestRunner;
  private readonly differ = new Differ();
  /** values captured by `after` steps, per environment — memory only, never written */
  private readonly captured = new Map<string, Record<string, string>>();

  constructor(readonly root: string, opts: WorkspaceOptions = {}) {
    this.apilotDir = join(root, ".apilot");
    this.secrets = opts.secrets ?? envSecrets;
    this.runner = new RequestRunner({ timeout: opts.timeout });
    this.store = new SnapshotStore(this.apilotDir, opts.retention ?? 20);
  }

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------

  exists(): boolean {
    return existsSync(join(this.apilotDir, "apilot.yaml"));
  }

  /** Create a starter `.apilot/` folder. Safe to call on an existing project. */
  init(name = "my-api"): void {
    const w = (rel: string, content: string) => {
      const file = join(this.apilotDir, rel);
      if (existsSync(file)) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    };
    w("apilot.yaml", toYaml({ name, defaultEnvironment: "dev", codegen: { dart: { enabled: true, output: "lib/api" }, typescript: { enabled: false, output: "src/api" } } }));
    w(".gitignore", "# local-only Apilot state (never commit)\n.local/\n");
    w("environments/dev.yaml", toYaml({ name: "dev", variables: { baseUrl: { type: "text", value: "https://jsonplaceholder.typicode.com" }, authToken: { type: "secret" } } }));
    w("collections/example/get-todo.yaml", toYaml({ name: "Get todo", method: "GET", url: "{{baseUrl}}/todos/1", headers: { Accept: "application/json" }, expect: { status: 200 } }));
  }

  get project(): ApilotProject {
    return this.registry().project;
  }

  registry(): ProjectRegistry {
    return new Registry(new NodeFileResolver(this.root)).build();
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  entry(id: string): EndpointEntry {
    const ep = this.registry().endpoints.find((e) => e.id === id);
    if (!ep) throw new Error(`Endpoint "${id}" not found. Use list_endpoints to see available ids.`);
    return ep;
  }

  endpoint(id: string): { entry: EndpointEntry; definition: EndpointFile } {
    const entry = this.entry(id);
    return { entry, definition: parseEndpointFile(readFileSync(join(this.root, entry.file), "utf-8"), entry.file) };
  }

  /** Create or update an endpoint file. Every change is recorded as a revision. */
  saveEndpoint(input: EndpointInput): { id: string; file: string; revision: number } {
    const { id, collection, label, ...def } = input;
    let file: string;
    let endpointId: string;
    if (id) {
      file = this.entry(id).file;
      endpointId = id;
    } else {
      const coll = (collection ?? "default").split("/").map(slugify).filter(Boolean).join("/") || "default";
      const base = slugify(def.name) || "endpoint";
      let slug = base;
      for (let n = 2; existsSync(join(this.apilotDir, "collections", coll, `${slug}.yaml`)); n++) slug = `${base}-${n}`;
      file = `.apilot/collections/${coll}/${slug}.yaml`;
      endpointId = `${coll}.${slug}`;
    }

    const clean = normalizeEndpoint(def);
    const yaml = toYaml(clean, { lineWidth: 0 });
    parseEndpointFile(yaml, file); // validate before touching disk
    mkdirSync(dirname(join(this.root, file)), { recursive: true });
    writeFileSync(join(this.root, file), yaml);
    return { id: endpointId, file, revision: this.recordRevision(endpointId, label) };
  }

  deleteEndpoint(id: string): void {
    rmSync(join(this.root, this.entry(id).file));
  }

  // -------------------------------------------------------------------------
  // Environments & variables
  // -------------------------------------------------------------------------

  envName(name?: string): string {
    const reg = this.registry();
    const env = name ?? reg.project.defaultEnvironment ?? reg.environments[0]?.name;
    if (!env) throw new Error("No environment found. Create one in .apilot/environments/ (e.g. dev.yaml).");
    if (!reg.environments.some((e) => e.name === env)) {
      throw new Error(`Environment "${env}" not found. Available: ${reg.environments.map((e) => e.name).join(", ") || "none"}`);
    }
    return env;
  }

  environment(name?: string): EnvironmentFile {
    const env = this.envName(name);
    return parseEnvironmentFile(readFileSync(this.envFile(env), "utf-8"), `${env}.yaml`);
  }

  async variables(envName?: string): Promise<VariableInfo[]> {
    const env = this.environment(envName);
    return Promise.all(
      Object.entries(env.variables).map(async ([name, v]) =>
        v.type === "secret"
          ? { name, type: "secret" as const, hasValue: !!(await this.secrets.get(env.name, name)) }
          : { name, type: "text" as const, value: String(v.value ?? "") }
      )
    );
  }

  /** Declare or update a variable. Secret *values* go to the keychain, never the file. */
  async setVariable(envName: string, name: string, type: "text" | "secret", value?: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name "${name}" (letters, digits, underscore).`);
    const env = this.environment(envName);
    env.variables[name] = type === "secret" ? ({ type: "secret" } as Variable) : ({ type: "text", value: value ?? "" } as Variable);
    this.writeEnv(env);
    if (type === "secret" && value !== undefined) {
      if (!this.secrets.set) throw new Error("Secret values can only be entered in the editor (or via APILOT_SECRET_<name> in CI).");
      await this.secrets.set(env.name, name, value);
    }
  }

  deleteVariable(envName: string, name: string): void {
    const env = this.environment(envName);
    delete env.variables[name];
    this.writeEnv(env);
  }

  createEnvironment(name: string, copyFrom?: string): void {
    const slug = slugify(name);
    if (!slug) throw new Error("Environment name is required.");
    if (existsSync(this.envFile(slug))) throw new Error(`Environment "${slug}" already exists.`);
    const variables = copyFrom ? this.environment(copyFrom).variables : {};
    this.writeEnv({ name: slug, variables });
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  async run(id: string, envName?: string): Promise<RunOutcome> {
    const env = this.envName(envName);
    const { definition } = this.endpoint(id);
    const def = this.withFolderDefaults(id, definition);
    const revision = this.recordRevision(id);
    const { variables, secretValues } = await this.resolveVariables(env, def);

    let request;
    try {
      request = this.runner.resolve(def, { variables, secretNames: Object.keys(secretValues) });
    } catch (err) {
      if (err instanceof VariableError) {
        throw new Error(`Variable "${err.variable}" is not defined in environment "${env}". Add it to .apilot/environments/${env}.yaml, or run the endpoint that captures it first (after: set).`);
      }
      throw err;
    }

    const raw = await this.runner.run(request, id, def.expect?.status);

    const captured: Record<string, string> = {};
    const envVars = this.environment(env).variables;
    const state = this.captured.get(env) ?? {};
    for (const step of def.after ?? []) {
      for (const [name, path] of Object.entries(step.set ?? {})) {
        const value = jsonPath(raw.body, path);
        if (value === undefined || value === null) continue;
        state[name] = typeof value === "object" ? JSON.stringify(value) : String(value);
        const sensitive = envVars[name]?.type === "secret" || new Redactor({ secretValues: {} }).isSensitiveKey(name);
        if (sensitive) secretValues[name] = state[name]!;
        captured[name] = sensitive ? "⟦REDACTED⟧" : state[name]!;
      }
    }
    this.captured.set(env, state);

    const snapshot = this.store.save(raw, secretValues, revision);
    const baseline = this.store.baseline(id);
    if (!baseline && snapshot.passed) this.store.setBaseline(id, snapshot.id);
    const diff = baseline && baseline.id !== snapshot.id
      ? this.differ.diff({ endpointId: id, from: baseline, to: snapshot })
      : undefined;

    return { endpointId: id, env, snapshot, diff, captured };
  }

  /** Run a collection (or everything) in order, so `after: set` chaining works. */
  async runAll(collectionId?: string, envName?: string): Promise<{ env: string; results: RunAllItem[]; passed: number; failed: number; breaking: number }> {
    const env = this.envName(envName);
    const endpoints = this.registry().endpoints.filter(
      (e) => !collectionId || e.collectionId === collectionId || e.collectionId.startsWith(`${collectionId}/`)
    );
    const results: RunAllItem[] = [];
    for (const ep of endpoints) {
      try {
        const r = await this.run(ep.id, env);
        results.push({
          endpointId: ep.id, name: ep.name, method: ep.method,
          status: r.snapshot.status, timeMs: r.snapshot.timeMs, passed: r.snapshot.passed,
          breaking: !!r.diff?.breaking, summary: r.diff?.summary,
        });
      } catch (err) {
        results.push({ endpointId: ep.id, name: ep.name, method: ep.method, passed: false, breaking: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      env,
      results,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      breaking: results.filter((r) => r.breaking).length,
    };
  }

  /** Names of secrets this endpoint needs that have no value yet. */
  async missingSecrets(id: string, envName?: string): Promise<string[]> {
    const env = this.envName(envName);
    const needed = this.neededSecrets(env, this.withFolderDefaults(id, this.endpoint(id).definition));
    const missing: string[] = [];
    for (const name of needed) if (!(await this.secrets.get(env, name))) missing.push(name);
    return missing;
  }

  // -------------------------------------------------------------------------
  // Snapshots, baseline, diff, schema
  // -------------------------------------------------------------------------

  snapshots(id: string): SnapshotMeta[] {
    this.entry(id);
    return this.store.list(id);
  }

  snapshot(id: string, snapshotId?: string): SnapshotRedacted {
    const s = snapshotId ? this.store.load(id, snapshotId) : this.store.latest(id);
    if (!s) throw new Error(snapshotId ? `Snapshot "${snapshotId}" not found for ${id}.` : `No snapshots for "${id}" yet. Run it first.`);
    return s;
  }

  setBaseline(id: string, snapshotId?: string): string {
    const target = snapshotId ?? this.snapshot(id).id;
    this.store.setBaseline(id, target);
    return target;
  }

  deleteSnapshot(id: string, snapshotId: string): void {
    if (this.store.baselineId(id) === snapshotId) throw new Error("That snapshot is the baseline. Accept another response as baseline first.");
    if (!this.store.path(id, snapshotId)) throw new Error(`Snapshot "${snapshotId}" not found for ${id}.`);
    this.store.delete(id, snapshotId);
  }

  /** Default: baseline → latest (or previous → latest when no baseline). */
  diff(id: string, fromId?: string, toId?: string): DiffResult {
    const list = this.snapshots(id);
    const to = toId ?? list[0]?.id;
    const from = fromId ?? (list.find((s) => s.baseline && s.id !== to) ?? list.find((s) => s.id !== to))?.id;
    if (!to || !from) throw new Error(`"${id}" needs at least two snapshots to compare. Run it again after the backend changes.`);
    return this.differ.diff({ endpointId: id, from: this.snapshot(id, from), to: this.snapshot(id, to) });
  }

  /** Response schema learned from every successful snapshot (optional/nullable fields included). */
  schema(id: string): ApilotSchema {
    const all = this.store.all(id);
    if (all.length === 0) throw new Error(`No snapshots for "${id}" yet. Run it first.`);
    const ok = all.filter((s) => s.passed);
    return ok.length ? new SchemaBuilder().infer(ok.map((s) => s.body)) : inferSchema(all[0]!.body);
  }

  // -------------------------------------------------------------------------
  // Revisions — small version history of the request definition
  // -------------------------------------------------------------------------

  revisions(id: string): Revision[] {
    const dir = this.historyDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => /^\d+\.yaml$/.test(f))
      .map((f) => parseYaml(readFileSync(join(dir, f), "utf-8")) as Revision)
      .sort((a, b) => b.revision - a.revision);
  }

  /** Record the current definition as a new revision if it changed. Returns the current revision number. */
  recordRevision(id: string, label?: string): number {
    const { definition } = this.endpoint(id);
    const current = normalizeEndpoint(definition);
    const [latest] = this.revisions(id);
    if (latest && JSON.stringify(normalizeEndpoint(latest.definition)) === JSON.stringify(current)) return latest.revision;

    const revision = (latest?.revision ?? 0) + 1;
    const rev: Revision = {
      revision,
      timestamp: new Date().toISOString(),
      ...(label ? { label } : {}),
      summary: latest ? summarizeChanges(revisionChanges(latest.definition, current)) : "First version",
      definition: current,
    };
    mkdirSync(this.historyDir(id), { recursive: true });
    writeFileSync(join(this.historyDir(id), `${revision}.yaml`), toYaml(rev, { lineWidth: 0 }));
    return revision;
  }

  /** Compare two revisions (default: previous → latest). */
  diffRevisions(id: string, from?: number, to?: number): { from: Revision; to: Revision; changes: RevisionChange[] } {
    const revs = this.revisions(id);
    const b = to !== undefined ? revs.find((r) => r.revision === to) : revs[0];
    const a = from !== undefined ? revs.find((r) => r.revision === from) : revs.find((r) => b && r.revision < b.revision);
    if (!a || !b) throw new Error(`"${id}" needs at least two revisions to compare.`);
    return { from: a, to: b, changes: revisionChanges(a.definition, b.definition) };
  }

  restoreRevision(id: string, revision: number): number {
    const rev = this.revisions(id).find((r) => r.revision === revision);
    if (!rev) throw new Error(`Revision ${revision} not found for ${id}.`);
    return this.saveEndpoint({ ...rev.definition, id, label: `Restored v${revision}` }).revision;
  }

  // -------------------------------------------------------------------------
  // Impact report
  // -------------------------------------------------------------------------

  /** Find code that uses the fields a diff says changed (breaking + warnings). */
  impact(id: string, diff: DiffResult = this.diff(id)): { fields: string[]; matches: ImpactMatch[] } {
    const fields = new Set<string>();
    for (const c of diff.changes) {
      if (c.level !== "breaking" && c.level !== "warning") continue;
      if (c.kind === "renamed") fields.add(String(c.fromValue));
      const last = c.path.replace(/\[\]/g, "").split(".").pop();
      if (last && last !== "$" && !last.startsWith("@")) fields.add(last);
    }
    if (fields.size === 0) return { fields: [], matches: [] };

    const patterns = [...fields].map((f) => ({
      field: f,
      re: new RegExp(`\\b(${escapeRe(f)}|${escapeRe(camel(f))})\\b`),
    }));

    const roots = new Set<string>(["lib", "src", "app", "test", "packages"]);
    for (const t of Object.values(this.project.codegen ?? {})) if (t?.output) roots.add(t.output);

    const matches: ImpactMatch[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      if (scanned > 5000 || matches.length > 500) return; // ponytail: bounded text scan; an index/LSP is the upgrade path
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full);
        } else if (CODE_EXT.test(name) && st.size < 512 * 1024) {
          scanned++;
          readFileSync(full, "utf-8").split("\n").forEach((text, i) => {
            for (const p of patterns) {
              if (p.re.test(text)) matches.push({ file: relative(this.root, full), line: i + 1, field: p.field, text: text.trim().slice(0, 200) });
            }
          });
        }
      }
    };
    for (const r of roots) walk(join(this.root, r));
    return { fields: [...fields], matches };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private envFile(env: string): string {
    const yml = join(this.apilotDir, "environments", `${env}.yml`);
    return existsSync(yml) ? yml : join(this.apilotDir, "environments", `${env}.yaml`);
  }

  private writeEnv(env: EnvironmentFile): void {
    const file = this.envFile(env.name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toYaml({ name: env.name, variables: env.variables }, { lineWidth: 0 }));
  }

  private historyDir(id: string): string {
    return join(this.apilotDir, "history", ...id.split("/"));
  }

  /** Merge `_folder.yaml` headers/auth from the collection folder chain. */
  private withFolderDefaults(id: string, def: EndpointFile): EndpointFile {
    const parts = dirname(this.entry(id).file).split("/");
    let headers: Record<string, string> = {};
    let auth = undefined as EndpointFile["auth"];
    for (let i = 3; i <= parts.length; i++) {
      const f = join(this.root, ...parts.slice(0, i), "_folder.yaml");
      if (!existsSync(f)) continue;
      const folder = (parseYaml(readFileSync(f, "utf-8")) ?? {}) as FolderFile;
      headers = { ...headers, ...(folder.headers ?? {}) };
      auth = folder.auth ?? auth;
    }
    return { ...def, headers: { ...headers, ...(def.headers ?? {}) }, auth: def.auth ?? auth };
  }

  private neededSecrets(env: string, def: EndpointFile): string[] {
    const vars = this.environment(env).variables;
    const used = new Set(referencedVars(JSON.stringify(def)));
    // Text variables can reference secrets, e.g. authHeader: "Bearer {{token}}".
    for (const name of [...used]) {
      const v = vars[name];
      if (v?.type === "text") for (const r of referencedVars(String(v.value ?? ""))) used.add(r);
    }
    return [...used].filter((n) => vars[n]?.type === "secret" && !this.captured.get(env)?.[n]);
  }

  private async resolveVariables(env: string, def: EndpointFile): Promise<{ variables: Record<string, string>; secretValues: Record<string, string> }> {
    const needed = this.neededSecrets(env, def);
    const secretValues: Record<string, string> = {};
    let missing: string[] = [];
    for (const name of needed) {
      const v = await this.secrets.get(env, name);
      if (v) secretValues[name] = v;
      else missing.push(name);
    }
    if (missing.length && this.secrets.prompt) {
      await this.secrets.prompt(env, missing);
      const still: string[] = [];
      for (const name of missing) {
        const v = await this.secrets.get(env, name);
        if (v) secretValues[name] = v;
        else still.push(name);
      }
      missing = still;
    }
    if (missing.length) {
      throw new Error(`Missing secret value(s) for "${env}": ${missing.join(", ")}. Enter them in the Apilot panel (Environments), or set APILOT_SECRET_<name> in CI.`);
    }

    const captured = this.captured.get(env) ?? {};
    const variables: Record<string, string> = { ...secretValues };
    for (const [name, v] of Object.entries(this.environment(env).variables)) {
      if (v.type === "text") variables[name] = String(v.value ?? "");
    }
    Object.assign(variables, captured);
    // Resolve text variables that reference other variables.
    for (const [name, v] of Object.entries(variables)) {
      try {
        variables[name] = interpolate(v, variables);
      } catch {
        /* reported when the request itself is resolved */
      }
    }
    for (const [name, v] of Object.entries(captured)) {
      if (this.environment(env).variables[name]?.type === "secret") secretValues[name] = v;
    }
    return { variables, secretValues };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal JSONPath: `$.data[0].id`, `$[0].id`, `$.['key']`. */
export function jsonPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.replace(/^\$/, "").split(/[.[\]'"]+/).filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function camel(s: string): string {
  return s.replace(/[-_]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonical key order and no empty sections — keeps YAML diffs clean. */
function normalizeEndpoint(def: EndpointFile): EndpointFile {
  const out: Record<string, unknown> = { name: def.name, method: def.method?.toUpperCase(), url: def.url };
  if (def.auth) out.auth = def.auth;
  if (def.query && Object.keys(def.query).length) out.query = def.query;
  if (def.headers && Object.keys(def.headers).length) out.headers = def.headers;
  if (def.body !== undefined && def.body !== null && def.body !== "") out.body = def.body;
  if (def.expect && Object.keys(def.expect).length) out.expect = def.expect;
  if (def.after?.length) out.after = def.after;
  return out as unknown as EndpointFile;
}

function flatten(def: EndpointFile): Record<string, string> {
  const flat: Record<string, string> = { method: def.method, url: def.url };
  for (const [k, v] of Object.entries(def.query ?? {})) flat[`query.${k}`] = String(v);
  for (const [k, v] of Object.entries(def.headers ?? {})) flat[`header.${k}`] = String(v);
  if (def.auth) for (const [k, v] of Object.entries(def.auth)) flat[`auth.${k}`] = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (def.body !== undefined && def.body !== null) flat.body = typeof def.body === "string" ? def.body : JSON.stringify(def.body, null, 2);
  if (def.expect?.status !== undefined) flat["expect.status"] = String(def.expect.status);
  if (def.after?.length) flat.after = JSON.stringify(def.after);
  if (def.name) flat.name = def.name;
  return flat;
}

export function revisionChanges(from: EndpointFile, to: EndpointFile): RevisionChange[] {
  const a = flatten(from);
  const b = flatten(to);
  const changes: RevisionChange[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) changes.push({ field: k, change: "added", to: b[k] });
    else if (!(k in b)) changes.push({ field: k, change: "removed", from: a[k] });
    else if (a[k] !== b[k]) changes.push({ field: k, change: "changed", from: a[k], to: b[k] });
  }
  return changes;
}

function summarizeChanges(changes: RevisionChange[]): string {
  if (changes.length === 0) return "No changes";
  const parts = changes.slice(0, 4).map((c) => {
    const [kind, ...rest] = c.field.split(".");
    const label = rest.length ? `${kind} ${rest.join(".")}` : kind;
    return `${c.change} ${label}`;
  });
  return parts.join(", ") + (changes.length > 4 ? ` (+${changes.length - 4} more)` : "");
}
