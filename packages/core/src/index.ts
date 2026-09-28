/**
 * @apilot/core — Core logic for Apilot.
 *
 * All shared logic lives here. Zero VS Code / editor dependencies.
 * The extension, MCP server, and CLI all depend on this package.
 */

// Types
export * from "./types.js";

// File format
export {
  Registry,
  NodeFileResolver,
  parseEndpointFile,
  parseEnvironmentFile,
  EndpointParseError,
  type FileResolver,
} from "./file-format.js";

// Variables
export {
  resolveContext,
  interpolate,
  referencedVars,
  VariableError,
  type SecretResolver,
} from "./variables.js";

// Redaction
export { Redactor, type RedactionOptions } from "./redaction.js";

// Runner
export { RequestRunner, RunnerError, cryptoId } from "./runner.js";

// Snapshots
export {
  JsonSnapshotStore,
  type SnapshotStore,
  type SnapshotStoreConfig,
} from "./snapshots.js";

// Diff engine
export { Differ, type DiffOptions, type DiffClassifier } from "./differ.js";

// Schema
export { SchemaBuilder, inferSchema, mergeSchemas, schemaToJsonSchema } from "./schema.js";

// Assertions
export { AssertionEngine, type Assertion, type AssertionResult } from "./assertions.js";
