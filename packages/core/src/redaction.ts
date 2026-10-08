/**
 * Redaction engine.
 *
 * Rule: every snapshot and MCP response is run through this before it is
 * written to disk or shown to an AI.  We mask:
 *  1. Known secret values (passed in from the resolved variable set).
 *  2. Sensitive URL query parameters by name (token, api_key, etc.).
 *  3. Common secret patterns (JWT, Bearer tokens, AWS keys, password= in forms).
 *  4. Sensitive header and body keys by name.
 *
 * Performance: single pass; O(n) in the number of redaction targets.
 */

export interface RedactionOptions {
  /** secret values keyed by their variable name. Never logged. */
  secretValues: Record<string, string>;
  /** header names to mask (case-insensitive match). */
  maskHeaders?: string[];
  replacement?: string;
}

const DEFAULT_MASK_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "api-key",
  "token",
  "proxy-authorization",
  "x-csrf-token",
  "x-secret",
];

/** Query parameter names whose values are treated as secrets. */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "access_token", "access-token", "refreshtoken", "refresh_token", "refresh-token",
  "apikey", "api_key", "api-key", "secret", "password", "passwd", "pwd",
  "auth", "auth_token", "authtoken", "key", "apikey", "credentials",
]);

export class Redactor {
  private readonly secretValues: string[];
  private readonly patterns: RegExp[];
  private readonly maskHeaders: Set<string>;
  private readonly replacement: string;

  constructor(opts: RedactionOptions) {
    this.secretValues = Object.values(opts.secretValues).filter(
      (v) => v && v.length > 0
    );
    this.maskHeaders = new Set(
      (opts.maskHeaders ?? DEFAULT_MASK_HEADERS).map((h) =>
        h.toLowerCase()
      )
    );
    this.replacement = opts.replacement ?? "⟦REDACTED⟧";

    // Patterns for things that *look* like secrets even if we don't know
    // the exact value.
    this.patterns = [
      // JWT
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      // Bearer ...
      /Bearer\s+[\w.-]+/gi,
      // AWS-style keys
      /AKIA[0-9A-Z]{16}/g,
      // Generic password=<value> in form bodies
      /(password|passwd|pwd)(\s*[:=]\s*)\S+/gi,
    ];
  }

  redactString(value: string): string {
    let out = this.redactUrl(value);
    // 1. Exact secret substrings
    for (const secret of this.secretValues) {
      if (secret.length > 3 && out.includes(secret)) {
        out = out.split(secret).join(this.replacement);
      }
    }
    // 2. Pattern-based masking
    for (const pattern of this.patterns) {
      out = out.replace(pattern, this.replacement);
    }
    return out;
  }

  /**
   * If the string looks like a URL, redact sensitive query parameters by name.
   * This catches cases where a secret value is not known exactly (e.g. a
   * redirect URL echoing a token) but the param name reveals it.
   */
  redactUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (!url.searchParams.toString()) return value;

    const parts: string[] = [];
    let changed = false;
    for (const [key, val] of url.searchParams) {
      const isSensitive = SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) && val;
      if (isSensitive) {
        parts.push(`${encodeURIComponent(key)}=${this.replacement}`);
        changed = true;
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
      }
    }
    if (!changed) return value;
    const origin = url.origin === "null" ? "" : url.origin;
    return `${origin}${url.pathname}?${parts.join("&")}${url.hash}`;
  }

  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (this.maskHeaders.has(key.toLowerCase())) {
        // Sensitive headers are fully masked
        result[key] = this.replacement;
      } else {
        result[key] = this.redactString(value);
      }
    }
    return result;
  }

  redactObject(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === "string") {
      return this.redactString(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.redactObject(v));
    }
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        // mask sensitive keys by name
        if (typeof val === "string" && val.length > 0 && this.isSensitiveKey(key)) {
          result[key] = this.replacement;
        } else {
          result[key] = this.redactObject(val);
        }
      }
      return result;
    }
    return value;
  }

  isSensitiveKey(key: string): boolean {
    return /(password|passwd|pwd|secret|token|api[_-]?key|authorization|credentials|private[_-]?key|access[_-]?key|session|jwt|cookie|client[_-]?secret)$/i.test(key);
  }
}
