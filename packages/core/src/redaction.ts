/**
 * Redaction engine.
 *
 * Rule: every snapshot and MCP response is run through this before it is
 * written to disk or shown to an AI.  We mask:
 *  1. Known secret values (passed in from the resolved variable set).
 *  2. Common secret patterns (JWT, Bearer tokens, API keys in headers).
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
];

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
      /eyJ[A-Za-z0-9_-]+\.[eyJ[A-Za-z0-9_-]+\.]?[A-Za-z0-9_-]+/g,
      // Bearer ...
      /Bearer\s+[\w.-]+/gi,
      // AWS-style keys
      /AKIA[0-9A-Z]{16}/g,
      // Generic password=<value> in form bodies
      /(password|passwd|pwd)(\s*[:=]\s*)\S+/gi,
    ];
  }

  redactString(value: string): string {
    let out = value;
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
        if (typeof val === "string" && this.isSensitiveKey(key)) {
          result[key] = this.redactString(val);
        } else {
          result[key] = this.redactObject(val);
        }
      }
      return result;
    }
    return value;
  }

  isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    return (
      lower === "password" ||
      lower === "token" ||
      lower === "secret" ||
      lower === "apikey" ||
      lower === "api-key" ||
      lower === "authorization" ||
      lower === "auth" ||
      lower.endsWith("token") ||
      lower.endsWith("secret") ||
      lower.endsWith("password") ||
      lower.endsWith("key")
    );
  }
}
