/**
 * @apilot/core — Core logic for Apilot.
 *
 * All shared logic lives here. Zero VS Code / editor dependencies.
 * The extension, MCP server, and CLI all depend on this package.
 */

export * from "./types.js";

export {
  Registry,
  NodeFileResolver,
  parseEndpointFile,
  parseEnvironmentFile,
  EndpointParseError,
  type FileResolver,
} from "./file-format.js";

export { interpolate, referencedVars, VariableError } from "./variables.js";
export { Redactor, type RedactionOptions } from "./redaction.js";
export { RequestRunner, RunnerError } from "./runner.js";
export { SnapshotStore } from "./snapshots.js";
export { Differ, type DiffOptions, type DiffClassifier } from "./differ.js";
export { SchemaBuilder, inferSchema, schemaToJsonSchema } from "./schema.js";

export {
  Workspace,
  envSecrets,
  jsonPath,
  slugify,
  revisionChanges,
  type SecretProvider,
  type WorkspaceOptions,
  type EndpointInput,
  type VariableInfo,
  type RunOutcome,
  type RunAllItem,
  type ImpactMatch,
} from "./workspace.js";

export { importSpec, tokenizeShell, type ImportSource, type ImportResult } from "./importers.js";
