/**
 * Apilot Skill — provides AI context about the Apilot workspace,
 * its file structure, MCP tools, and workflow rules.
 *
 * This module reads the template SKILL.md and injects project-specific
 * context (collection list, endpoint list, environment names) so that
 * AI assistants using Claude/Cursor/VS Code receive accurate, up-to-date
 * information about the workspace they're operating on.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { Registry, NodeFileResolver } from "@apilot/core";

const TEMPLATE_PATH = resolve(__dirname, "..", "template", "SKILL.md");

/**
 * Read the SKILL.md template.
 * @returns The raw template content.
 */
export function loadTemplate(): string {
  try {
    return readFileSync(TEMPLATE_PATH, "utf-8");
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

/**
 * Build a project-aware SKILL.md by injecting the current project's
 * collections, endpoints, and environments into the template.
 *
 * @param projectRoot - Path to the directory containing `.apilot/`
 * @returns A rendered SKILL.md string.
 */
export function renderSkill(projectRoot: string): string {
  const apilotDir = resolve(projectRoot, ".apilot");
  if (!existsSync(apilotDir)) {
    return loadTemplate();
  }

  const files = new NodeFileResolver(projectRoot);
  const registry = new Registry(files).build();

  let template = loadTemplate();

  // Inject project name
  template = template.replace(
    /\{\{PROJECT_NAME\}\}/g,
    registry.project.name ?? "apilot-project"
  );

  // Inject collection list
  const collectionList = registry.collections
    .map((c) => `  - \`${c.id}\` — ${c.name}`)
    .join("\n") || "  (no collections — import some endpoints)";
  template = template.replace(/\{\{COLLECTIONS\}\}/g, collectionList);

  // Inject endpoint list
  const endpointList = registry.endpoints
    .map((e) => `  - \`${e.id}\` — ${e.method} ${e.url} (collection: \`${e.collectionId}\`)`)
    .join("\n") || "  (no endpoints — add some in `.apilot/collections/`)";
  template = template.replace(/\{\{ENDPOINTS\}\}/g, endpointList);

  // Inject environment list
  const envList = registry.environments
    .map((e) => `  - \`${e.name}\``).join("\n") || "  (no environments defined)";
  template = template.replace(/\{\{ENVIRONMENTS\}\}/g, envList);

  // Inject codegen targets
  const codegenTargets = Object.keys(registry.project.codegen ?? {})
    .map((k) => `  - \`${k}\``)
    .join("\n") || "  (no codegen targets configured)";
  template = template.replace(/\{\{CODEGEN_TARGETS\}\}/g, codegenTargets);

  return template;
}

/**
 * Write the rendered SKILL.md into the project's `.apilot/` directory.
 * Called by the extension on activation and on file changes.
 */
export function writeSkill(projectRoot: string): string {
  const apilotDir = resolve(projectRoot, ".apilot");
  const skillPath = resolve(apilotDir, "SKILL.md");
  const content = renderSkill(projectRoot);
  mkdirSync(apilotDir, { recursive: true });
  writeFileSync(skillPath, content, "utf-8");
  return skillPath;
}

const DEFAULT_TEMPLATE = `# Apilot — AI Assistant Skill

> This file gives AI assistants context about your Apilot API workspace.

## What is Apilot?
Apilot is an API workspace that lives inside your editor (VS Code/Cursor).
It lets you define, run, version, and diff API endpoints — and gives AI
assistants access to the same capabilities via the Model Context Protocol (MCP).

## File Structure
\`\`\`
.apilot/
  apilot.yaml        # project config (name, default env, codegen targets)
  environments/      # env-specific variables + secrets
  collections/       # endpoint definitions (YAML, nested folders)
  snapshots/         # saved request/response pairs for diffing
  generated/         # codegen output (Dart, TS, Kotlin, Swift)
  SKILL.md           # this file (AI context)
\`\`\`

## MCP Tools (12 available)
- \`list_endpoints\` — discover collections + endpoints
- \`get_endpoint\` — get full endpoint definition
- \`run_endpoint\` — execute an endpoint, get redacted response
- \`run_collection\` — run all endpoints in a collection
- \`get_schema\` — infer JSON schema from response
- \`diff_endpoint\` — compare two snapshots, classify changes
- \`impact_report\` — assess severity of API response changes
- \`generate_code\` — generate typed models + API clients
- \`add_endpoint\` — create a new endpoint definition
- \`update_endpoint\` — modify an endpoint
- \`list_variables\` — list env variables (secrets masked)
- \`import_spec\` — import from cURL, Postman, OpenAPI, HAR

## How to Work
1. Use \`list_endpoints\` to discover APIs.
2. Use \`list_variables\` to see what's defined (secrets are always masked).
3. Run endpoints with \`run_endpoint\` — secrets come from env vars (\`APilot_secret_<name>\`).
4. Use \`diff_endpoint\` to detect breaking changes between runs.
5. Use \`generate_code\` to produce typed models.

## Critical Rules
- Never output raw secret values. If a secret is needed, use the env-var mechanism.
- Generated code is always marked "do not edit by hand."
- Always check \`diff_endpoint\` before deploying API changes.
- Use the project's own file structure (\`.apilot/\`) for all operations.
`;

export default { loadTemplate, renderSkill, writeSkill };
