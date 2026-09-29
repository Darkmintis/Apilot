/**
 * Importers: cURL, Postman v2.x collections, OpenAPI 3 / Swagger 2.
 *
 * Imported credentials are never written to endpoint files. Tokens and
 * passwords become `{{secret}}` variables; their values go to the keychain
 * when the caller's SecretProvider supports it.
 */

import { parse as parseYaml } from "yaml";
import type { EndpointAuth, EndpointFile, HttpMethod } from "./types.js";
import type { Workspace } from "./workspace.js";
import { slugify } from "./workspace.js";

export type ImportSource = "curl" | "postman" | "openapi";

export interface ImportResult {
  created: string[];
  notes: string[];
}

interface Draft extends EndpointFile {
  collection: string;
}

interface Ctx {
  ws: Workspace;
  env: string;
  notes: string[];
  secrets: Record<string, string>;
  textVars: Record<string, string>;
}

export async function importSpec(ws: Workspace, source: ImportSource, content: string, collection?: string, envName?: string): Promise<ImportResult> {
  const env = ws.envName(envName);
  const ctx: Ctx = { ws, env, notes: [], secrets: {}, textVars: {} };

  let drafts: Draft[];
  if (source === "curl") drafts = [fromCurl(content, collection ?? "imported", ctx)];
  else {
    let doc: any;
    try {
      doc = parseYaml(content);
    } catch (err) {
      throw new Error(`Could not parse ${source} content: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!doc || typeof doc !== "object") throw new Error(`The ${source} content is empty or not an object.`);
    drafts = source === "postman" ? fromPostman(doc, collection, ctx) : fromOpenApi(doc, collection, ctx);
  }
  if (drafts.length === 0) throw new Error(`No requests found in the ${source} content.`);

  const existing = Object.keys(ws.environment(env).variables);
  for (const [name, value] of Object.entries(ctx.textVars)) {
    if (!existing.includes(name)) await ws.setVariable(env, name, "text", value);
  }
  for (const [name, value] of Object.entries(ctx.secrets)) {
    try {
      await ws.setVariable(env, name, "secret", value || undefined);
    } catch {
      await ws.setVariable(env, name, "secret");
      ctx.notes.push(`Secret "${name}" was declared in "${env}" but its value was not saved — enter it in the Environments panel.`);
    }
  }

  const created = drafts.map(({ collection: coll, ...def }) => ws.saveEndpoint({ ...def, collection: coll, label: `Imported from ${source}` }).id);
  return { created, notes: ctx.notes };
}

// ---------------------------------------------------------------------------
// cURL
// ---------------------------------------------------------------------------

export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  const s = input.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

function fromCurl(input: string, collection: string, ctx: Ctx): Draft {
  const t = tokenizeShell(input.trim());
  if (t[0] === "curl") t.shift();
  let method: string | undefined;
  let url: string | undefined;
  const headers: Record<string, string> = {};
  const data: string[] = [];
  let user: string | undefined;

  for (let i = 0; i < t.length; i++) {
    const a = t[i]!;
    const next = () => t[++i] ?? "";
    if (a === "-X" || a === "--request") method = next().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = next();
      const idx = h.indexOf(":");
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(a)) data.push(next());
    else if (a === "--json") {
      data.push(next());
      headers["Content-Type"] ??= "application/json";
      headers.Accept ??= "application/json";
    } else if (a === "-u" || a === "--user") user = next();
    else if (a === "--url") url = next();
    else if (a.startsWith("-X") && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a.startsWith("-")) {
      if (["-o", "--output", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-m", "--max-time", "--connect-timeout"].includes(a)) i++;
    } else if (!url) url = a;
  }
  if (!url) throw new Error("No URL found in the cURL command.");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;

  const parsed = new URL(url);
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => (query[k] = v));
  const body = data.length ? data.join("&") : null;

  const def: Draft = {
    collection,
    name: `${method ?? (body ? "POST" : "GET")} ${parsed.pathname}`,
    method: (method ?? (body ? "POST" : "GET")) as HttpMethod,
    url: baseUrlOf(parsed.origin, ctx) + parsed.pathname,
    query,
    headers,
    body: tryJson(body),
  };
  extractAuth(def, ctx);
  if (user) {
    const [username, ...pw] = user.split(":");
    ctx.secrets.basicPassword = pw.join(":");
    def.auth = { type: "basic", username: username ?? "", password: "{{basicPassword}}" };
  }
  return def;
}

// ---------------------------------------------------------------------------
// Postman v2.x
// ---------------------------------------------------------------------------

function fromPostman(doc: any, collection: string | undefined, ctx: Ctx): Draft[] {
  if (!Array.isArray(doc.item)) throw new Error("Not a Postman v2 collection (missing `item`).");
  const root = collection ?? slugify(doc.info?.name ?? "postman");
  for (const v of doc.variable ?? []) {
    if (!v?.key) continue;
    if (isSensitive(v.key)) ctx.secrets[v.key] = String(v.value ?? "");
    else ctx.textVars[v.key] = String(v.value ?? "");
  }
  const collAuth = postmanAuth(doc.auth, ctx);
  const drafts: Draft[] = [];

  const walk = (items: any[], path: string[], inherited?: EndpointAuth) => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        walk(item.item, [...path, slugify(item.name ?? "folder")], postmanAuth(item.auth, ctx) ?? inherited);
        continue;
      }
      const r = item.request;
      if (!r) continue;
      const rawUrl = typeof r.url === "string" ? r.url : r.url?.raw ?? "";
      const [urlPart, qs] = rawUrl.split("?");
      const query: Record<string, string> = {};
      for (const q of (typeof r.url === "object" ? r.url?.query : undefined) ?? []) if (!q.disabled && q.key) query[q.key] = String(q.value ?? "");
      if (!Object.keys(query).length && qs) new URLSearchParams(qs).forEach((v, k) => (query[k] = v));
      const headers: Record<string, string> = {};
      for (const h of r.header ?? []) if (!h.disabled && h.key) headers[h.key] = String(h.value ?? "");

      let body: EndpointFile["body"] = null;
      if (r.body?.mode === "raw") body = tryJson(r.body.raw ?? null);
      else if (r.body?.mode === "urlencoded") {
        body = new URLSearchParams((r.body.urlencoded ?? []).filter((p: any) => !p.disabled).map((p: any) => [p.key, p.value ?? ""])).toString();
        headers["Content-Type"] ??= "application/x-www-form-urlencoded";
      } else if (r.body?.mode === "graphql") {
        body = { query: r.body.graphql?.query ?? "", variables: tryJson(r.body.graphql?.variables ?? null) ?? {} };
      } else if (r.body?.mode) ctx.notes.push(`"${item.name}": ${r.body.mode} bodies are not supported yet; body skipped.`);

      const def: Draft = {
        collection: [root, ...path].join("/"),
        name: item.name ?? `${r.method} ${urlPart}`,
        method: String(r.method ?? "GET").toUpperCase() as HttpMethod,
        url: urlPart ?? "",
        query,
        headers,
        body,
        auth: postmanAuth(r.auth, ctx) ?? inherited ?? collAuth,
      };
      extractAuth(def, ctx);
      drafts.push(def);
    }
  };
  walk(doc.item, []);
  return drafts;
}

function postmanAuth(auth: any, ctx: Ctx): EndpointAuth | undefined {
  if (!auth?.type || auth.type === "noauth") return undefined;
  const get = (key: string) => {
    const list = auth[auth.type];
    const v = Array.isArray(list) ? list.find((x: any) => x.key === key)?.value : list?.[key];
    return v === undefined ? "" : String(v);
  };
  const secretRef = (name: string, value: string) => {
    if (/^\{\{\w+\}\}$/.test(value)) return value;
    ctx.secrets[name] = value;
    return `{{${name}}}`;
  };
  if (auth.type === "bearer") return { type: "bearer", token: secretRef("authToken", get("token")) };
  if (auth.type === "basic") return { type: "basic", username: get("username"), password: secretRef("basicPassword", get("password")) };
  if (auth.type === "apikey") return { type: "apiKey", in: get("in") === "query" ? "query" : "header", name: get("key") || "X-API-Key", key: secretRef("apiKey", get("value")) };
  ctx.notes.push(`Postman auth type "${auth.type}" is not supported; add auth manually.`);
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAPI 3 / Swagger 2
// ---------------------------------------------------------------------------

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function fromOpenApi(doc: any, collection: string | undefined, ctx: Ctx): Draft[] {
  if (!doc.paths || (!doc.openapi && !doc.swagger)) throw new Error("Not an OpenAPI 3 / Swagger 2 document (missing `openapi`/`swagger` or `paths`).");
  const server = doc.servers?.[0]?.url ?? (doc.host ? `${doc.schemes?.[0] ?? "https"}://${doc.host}${doc.basePath ?? ""}` : "");
  if (server) ctx.textVars.baseUrl = server.replace(/\/$/, "");

  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const authFor = (security: any[] | undefined): EndpointAuth | undefined => {
    for (const req of security ?? doc.security ?? []) {
      for (const name of Object.keys(req ?? {})) {
        const s = schemes[name];
        if (!s) continue;
        if ((s.type === "http" && s.scheme === "bearer") || s.type === "oauth2" || s.type === "openIdConnect") {
          ctx.secrets.authToken ??= "";
          return { type: "bearer", token: "{{authToken}}" };
        }
        if (s.type === "http" && s.scheme === "basic") {
          ctx.secrets.basicPassword ??= "";
          ctx.textVars.basicUser ??= "";
          return { type: "basic", username: "{{basicUser}}", password: "{{basicPassword}}" };
        }
        if (s.type === "apiKey" && s.in !== "cookie") {
          ctx.secrets.apiKey ??= "";
          return { type: "apiKey", in: s.in === "query" ? "query" : "header", name: s.name, key: "{{apiKey}}" };
        }
      }
    }
    return undefined;
  };

  const drafts: Draft[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => (p.$ref ? resolveRef(doc, p.$ref) : p)).filter(Boolean);
      const query: Record<string, string> = {};
      const headers: Record<string, string> = { Accept: "application/json" };
      for (const p of params) {
        const example = String(p.example ?? p.schema?.example ?? p.schema?.default ?? p.default ?? "");
        if (p.in === "path") ctx.textVars[p.name] ??= example;
        if (p.in === "query" && p.required) query[p.name] = example;
        if (p.in === "header" && p.required && !/^authorization$/i.test(p.name)) headers[p.name] = example;
      }
      const json = op.requestBody?.content?.["application/json"];
      const bodyParam = params.find((p: any) => p.in === "body");
      const example = json?.example ?? firstExample(json?.examples) ?? exampleFromSchema(doc, json?.schema ?? bodyParam?.schema);
      if (example !== undefined) headers["Content-Type"] = "application/json";
      const okStatus = Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c));

      drafts.push({
        collection: collection ?? (slugify(op.tags?.[0] ?? "api") || "api"),
        name: op.summary ?? op.operationId ?? `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase() as HttpMethod,
        url: `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, (_: string, n: string) => `{{${n.replace(/[^A-Za-z0-9_]/g, "_")}}}`)}`,
        query,
        headers,
        body: example ?? null,
        auth: authFor(op.security),
        expect: okStatus ? { status: Number(okStatus) } : undefined,
      });
    }
  }
  return drafts;
}

function resolveRef(doc: any, ref: string): any {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce((o: any, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
}

function firstExample(examples: any): unknown {
  const first = examples && Object.values<any>(examples)[0];
  return first?.value;
}

function exampleFromSchema(doc: any, schema: any, depth = 0): unknown {
  if (!schema || depth > 6) return undefined;
  if (schema.$ref) return exampleFromSchema(doc, resolveRef(doc, schema.$ref), depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: any) => exampleFromSchema(doc, s, depth + 1) ?? {}));
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant) return exampleFromSchema(doc, variant, depth + 1);
  switch (schema.type) {
    case "object":
    case undefined: {
      if (!schema.properties) return schema.type ? {} : undefined;
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries<any>(schema.properties)) {
        if (s?.readOnly) continue;
        out[k] = exampleFromSchema(doc, s, depth + 1) ?? null;
      }
      return out;
    }
    case "array":
      return [exampleFromSchema(doc, schema.items, depth + 1)].filter((x) => x !== undefined);
    case "string":
      return schema.enum?.[0] ?? (schema.format === "date-time" ? "2026-01-01T00:00:00Z" : schema.format === "email" ? "user@example.com" : "string");
    case "integer":
    case "number":
      return schema.enum?.[0] ?? 0;
    case "boolean":
      return false;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function baseUrlOf(origin: string, ctx: Ctx): string {
  const current = ctx.ws.environment(ctx.env).variables.baseUrl;
  const value = current?.type === "text" ? current.value : ctx.textVars.baseUrl;
  if (value === undefined) {
    ctx.textVars.baseUrl = origin;
    return "{{baseUrl}}";
  }
  return value.replace(/\/$/, "") === origin ? "{{baseUrl}}" : origin;
}

/** Move credentials out of headers into secret variables. */
function extractAuth(def: Draft, ctx: Ctx): void {
  for (const [name, value] of Object.entries(def.headers ?? {})) {
    if (/\{\{\w+\}\}/.test(value)) continue;
    if (/^authorization$/i.test(name)) {
      const bearer = /^Bearer\s+(.+)$/i.exec(value);
      if (bearer) {
        ctx.secrets.authToken = bearer[1]!;
        def.auth = { type: "bearer", token: "{{authToken}}" };
      } else {
        ctx.secrets.authHeader = value;
        def.headers![name] = "{{authHeader}}";
        continue;
      }
      delete def.headers![name];
    } else if (isSensitive(name) || /^(x-api-key|api-key|cookie)$/i.test(name)) {
      const varName = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase());
      ctx.secrets[varName] = value;
      def.headers![name] = `{{${varName}}}`;
    }
  }
}

function isSensitive(name: string): boolean {
  return /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|access[_-]?key)$/i.test(name);
}

function tryJson(raw: string | null): EndpointFile["body"] {
  if (raw === null || raw === "") return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v : raw;
  } catch {
    return raw;
  }
}
