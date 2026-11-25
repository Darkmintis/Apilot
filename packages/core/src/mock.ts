/**
 * Mock server: answers the project's endpoints from their `mock:` block or
 * their baseline response, so an app (even one on a phone) can call a real
 * HTTP API before the backend exists or while it is down.
 */

import { createServer, type Server } from "node:http";
import type { EndpointFile, HttpMethod, SnapshotRedacted } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface MockRoute {
  id: string;
  method: HttpMethod;
  segments: string[];
}

export interface MockLogEntry {
  method: string;
  path: string;
  status: number;
  endpointId?: string;
}

export interface MockOptions {
  port?: number;
  /** "0.0.0.0" (default) is reachable from phones on the same network; "127.0.0.1" is this machine only */
  host?: string;
  onRequest?: (entry: MockLogEntry) => void;
}

export interface MockHandle {
  port: number;
  host: string;
  routes: MockRoute[];
  close(): Promise<void>;
}

const PLACEHOLDER = /^(\{\{[^}]*\}\}|:[\w-]+|\{[^}]*\})$/;

/** `{{baseUrl}}/orders/{{id}}?x=1` → ["orders", "{{id}}"]. A leading host or `{{baseUrl}}` is dropped. */
export function routeSegments(url: string): string[] {
  const path = url.split("?")[0]!.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/^\{\{[^}]*\}\}/, "");
  return path.split("/").filter(Boolean);
}

/**
 * The route that answers `method path`, or undefined. The route may be a
 * suffix of the path, so an app whose base URL has a prefix (`/v1`) still matches.
 * The most specific route (most literal segments, then longest) wins.
 */
export function matchRoute(routes: MockRoute[], method: string, path: string): MockRoute | undefined {
  const parts = path.split("/").filter(Boolean).map((p) => safeDecode(p));
  let best: { route: MockRoute; score: number } | undefined;
  for (const route of routes) {
    if (route.method !== method.toUpperCase() || route.segments.length > parts.length) continue;
    if (!route.segments.length && parts.length) continue; // the root route matches only "/"
    const tail = parts.slice(parts.length - route.segments.length);
    if (!route.segments.every((s, i) => PLACEHOLDER.test(s) || s === tail[i])) continue;
    const literals = route.segments.filter((s) => !PLACEHOLDER.test(s)).length;
    const score = literals * 100 + route.segments.length * 10 - (parts.length - route.segments.length);
    if (!best || score > best.score) best = { route, score };
  }
  return best?.route;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface MockReply {
  status: number;
  headers: Record<string, string>;
  body: string;
  delay: number;
}

/** What to send for an endpoint: its `mock` block over its baseline, or undefined when it has neither. */
export function mockReply(def: EndpointFile, baseline: SnapshotRedacted | undefined): MockReply | undefined {
  const m = def.mock;
  if (!m && !baseline) return undefined;
  const raw = m?.body !== undefined ? m.body : baseline?.body;
  const isText = typeof raw === "string";
  const headers: Record<string, string> = isText ? { "content-type": baseline?.headers["content-type"] ?? "text/plain" } : { "content-type": "application/json" };
  Object.assign(headers, m?.headers);
  return {
    status: m?.status ?? baseline?.status ?? 200,
    headers,
    body: isText ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw),
    delay: Math.max(0, m?.delay ?? 0),
  };
}

export function buildRoutes(ws: Workspace): MockRoute[] {
  return ws.registry().endpoints.map((e) => ({ id: e.id, method: e.method, segments: routeSegments(e.url) }));
}

export async function startMockServer(ws: Workspace, opts: MockOptions = {}): Promise<MockHandle> {
  const host = opts.host ?? "0.0.0.0";
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const log = (status: number, endpointId?: string) => opts.onRequest?.({ method: req.method ?? "GET", path, status, endpointId });
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const send = (status: number, headers: Record<string, string>, body: string, id?: string) => {
      res.writeHead(status, { ...cors, ...headers });
      res.end(body);
      log(status, id);
    };
    try {
      if (req.method === "OPTIONS") return send(204, {}, "");
      // Re-read every request: endpoints and baselines change while the server runs.
      const routes = buildRoutes(ws);
      const route = matchRoute(routes, req.method ?? "GET", path);
      const reply = route && mockReply(ws.endpoint(route.id).definition, ws.store.baseline(route.id));
      if (!route || !reply) {
        const hint = route ? `"${route.id}" has no mock and no baseline yet. Run it once, or add a mock: block.` : "No endpoint matches this method and path.";
        return send(404, { "content-type": "application/json" }, JSON.stringify({ error: "apilot-mock: not found", hint, routes: routes.map((r) => `${r.method} /${r.segments.join("/")}`) }), route?.id);
      }
      setTimeout(() => send(reply.status, reply.headers, reply.body, route.id), reply.delay);
    } catch (err) {
      send(500, { "content-type": "application/json" }, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    host,
    routes: buildRoutes(ws),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
