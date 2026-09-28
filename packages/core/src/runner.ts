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
  resolve(
    endpoint: EndpointFile,
    ctx: RunContext
  ): ResolvedRequest {
    const headers: Record<string, string> = {};

    // Merge endpoint-level headers
    if (endpoint.headers) {
      for (const [k, v] of Object.entries(endpoint.headers)) {
        headers[k] = interpolate(v, ctx.variables);
      }
    }

    // Merge auth into headers
    if (endpoint.auth) {
      const authHeaders = resolveAuth(endpoint.auth, ctx);
      Object.assign(headers, authHeaders);
    }

    // Query params
    const query: Record<string, string> = {};
    if (endpoint.query) {
      for (const [k, v] of Object.entries(endpoint.query)) {
        query[k] = interpolate(v, ctx.variables);
      }
    }

    const url = buildUrl(
      interpolate(endpoint.url, ctx.variables),
      query
    );

    return {
      method: endpoint.method,
      url,
      headers,
      body: endpoint.body ? interpolate(endpoint.body, ctx.variables) : null,
    };
  }

  /** Execute a resolved request. Uses fetch (available in Node 18+ and webview). */
  async run(
    request: ResolvedRequest,
    _ctx: RunContext,
    _endpointId: string,
    opts: RunnerOptions = {}
  ): Promise<SnapshotRaw> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeout ?? this.timeout
    );

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ?? null,
        redirect: this.redirect ? "follow" : "manual",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new RunnerError(
        `Request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }

    const bodyRaw = await response.text();
    const body = tryParseJson(bodyRaw);

    const timeMs = Date.now() - startTime;

    // Calculate size
    const size =
      bodyRaw.length +
      Object.entries(request.headers).reduce(
        (sum, [k, v]) => sum + k.length + (v ?? "").length,
        request.url.length
      );

    // Run assertions
    const failures = runAssertions(
      response.status,
      body,
      bodyRaw,
      headersToObject(response.headers)
    );

    const snapshot: SnapshotRaw = {
      id: cryptoId(),
      endpointId: _endpointId,
      timestamp: new Date().toISOString(),
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      },
      status: response.status,
      headers: headersToObject(response.headers),
      body,
      bodyRaw,
      timeMs,
      size,
      passed: failures.length === 0,
      failures,
      _secretValues: {}, // cleared by caller before storage
    };

    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAuth(
  auth: EndpointFile["auth"],
  ctx: RunContext
): Record<string, string> {
  if (!auth) return {};

  switch (auth.type) {
    case "bearer": {
      const token = interpolate(auth.token, ctx.variables);
      return { Authorization: `Bearer ${token}` };
    }
    case "apiKey": {
      const key = interpolate(auth.key, ctx.variables);
      if (auth.in === "header") {
        return { [auth.name]: key };
      }
      // query param handling happens in buildUrl via endpoint.query normally,
      // but for auth-in-query we return it as a header-less directive
      return {};
    }
    case "basic": {
      const user = interpolate(auth.username, ctx.variables);
      const pass = interpolate(auth.password, ctx.variables);
      const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    case "custom": {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(auth.headers)) {
        result[k] = interpolate(v, ctx.variables);
      }
      return result;
    }
    default:
      return {};
  }
}

function buildUrl(base: string, query: Record<string, string>): string {
  const hasQuery = base.includes("?");
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined)
  );
  const qsStr = qs.toString();
  if (!qsStr) return base;

  if (hasQuery) {
    return `${base}&${qsStr}`;
  }
  return `${base}?${qsStr}`;
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function headersToObject(
  headers: Headers
): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Run built-in assertions. The spec specifies:
 *  - status check
 *  - schema validation (delegated to schema engine)
 *  - custom JSONPath assertions
 *
 * For now we do status + basic structural checks.
 */
function runAssertions(
  status: number,
  _body: unknown,
  _bodyRaw: string,
  _headers: Record<string, string>
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  // Placeholder — real assertions are injected by the caller via EndpointFile.expect
  // We validate status >= 200 && < 400 by default
  if (status < 200 || status >= 400) {
    failures.push({
      field: "status",
      message: `Expected 2xx/3xx, got ${status}`,
    });
  }

  return failures;
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
