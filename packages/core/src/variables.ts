/**
 * Variable resolution.
 *
 * Replaces {{varName}} placeholders in URLs, headers, body, and auth fields.
 * Secret variables are resolved via a callback — the core never stores
 * secret *values* in plain text beyond the live run, and never writes them.
 */

/** Synchronous variable interpolation. */
export function interpolate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    const v = variables[key];
    if (v === undefined) {
      throw new VariableError(
        key,
        `Variable "${key}" is not defined in this environment.`
      );
    }
    return v;
  });
}

export class VariableError extends Error {
  constructor(
    public readonly variable: string,
    message: string
  ) {
    super(message);
    this.name = "VariableError";
  }
}

/**
 * Determine which variables are referenced in a template string.
 */
export function referencedVars(template: string): string[] {
  const matches = template.match(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g);
  if (!matches) return [];
  return matches.map((m) =>
    m.replace(/\{\{\s*/, "").replace(/\s*\}\}/, "")
  );
}
