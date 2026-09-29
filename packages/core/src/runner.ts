/**
 * HTTP Runner — executes a resolved request and captures the result.
 *
 * Runs in the extension host (so no CORS) and in Node for CI.
 * Secrets are resolved by the caller and passed in the context; the runner
 * itself does NOT persist them.
 */

import type {
  AssertionFailure,
  EndpointFile,
  ResolvedRequest,
  RunContext,
  SnapshotRaw,
} from "./types.js";
import { interpolate } from "./variables.js";

export interface RunnerOptions {
  /** timeout in ms, default 30_000 */
  timeout?: number;
  /** follow redirects, default true */
  redirect?: boolean;
}

export class RequestRunner {
  private readonly timeout: number;
  private readonly redirect: boolean;

  constructor(opts: RunnerOptions = {}) {
    this.timeout = opts.timeout ?? 30_000;
    this.redirect = opts.redirect ?? true;
  }

  /** Build a fully-resolved request from an endpoint definition + context. */
  resolve(endpoint: EndpointFile, ctx: RunContext): ResolvedRequest {
    const v = ctx.variables;
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(endpoint.headers ?? {})) headers[k] = interpolate(String(val), v);

    const query: Record<string, string> = {};
    for (const [k, val] of Object.entries(endpoint.query ?? {})) query[k] = interpolate(String(val), v);

    const auth = endpoint.auth;
    if (auth?.type === "bearer") headers.Authorization = `Bearer ${interpolate(auth.token, v)}`;
    if (auth?.type === "basic") {
      const encoded = Buffer.from(`${interpolate(auth.username, v)}:${interpolate(auth.password, v)}`).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
    }
    if (auth?.type === "apiKey") (auth.in === "query" ? query : headers)[auth.name] = interpolate(auth.key, v);
    if (auth?.type === "custom") for (const [k, val] of Object.entries(auth.headers)) headers[k] = interpolate(val, v);

    let body: string | null = null;
    if (endpoint.body !== null && endpoint.body !== undefined) {
      const isObject = typeof endpoint.body === "object";
      body = interpolate(isObject ? JSON.stringify(endpoint.body) : String(endpoint.body), v);
      if (isObject && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    return { method: endpoint.method, url: buildUrl(interpolate(endpoint.url, v), query), headers, body };
  }

  /** Execute a resolved request. `expectStatus` defaults to "any 2xx/3xx". */
  async run(request: ResolvedRequest, endpointId: string, expectStatus?: number): Promise<SnapshotRaw> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    let bodyRaw: string;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: this.redirect ? "follow" : "manual",
        signal: controller.signal,
      });
      bodyRaw = await response.text();
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeout} ms`
        : errorMessage(err);
      throw new RunnerError(`Request to ${request.url} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const failures: AssertionFailure[] = [];
    if (expectStatus !== undefined ? response.status !== expectStatus : response.status < 200 || response.status >= 400) {
      failures.push({
        field: "@status",
        message: expectStatus !== undefined ? `Expected status ${expectStatus}, got ${response.status}` : `Expected 2xx/3xx, got ${response.status}`,
      });
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key] = value));

    return {
      id: cryptoId(),
      endpointId,
      timestamp: new Date().toISOString(),
      request,
      status: response.status,
      headers,
      body: tryParseJson(bodyRaw),
      bodyRaw,
      timeMs: Date.now() - startTime,
      size: Buffer.byteLength(bodyRaw),
      passed: failures.length === 0,
      failures,
    };
  }
}

function buildUrl(base: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  if (!qs) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

export function cryptoId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}
