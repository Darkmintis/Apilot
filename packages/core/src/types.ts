/**
 * Public type surface for @apilot/core.
 * Core has zero editor dependencies — it only talks files and HTTP.
 */

// ---------------------------------------------------------------------------
// Project / environment
// ---------------------------------------------------------------------------

export interface ApilotProject {
  name: string;
  defaultEnvironment?: string;
  codegen?: CodegenTargets;
}

export interface CodegenTargets {
  [language: string]: CodegenTarget;
}

export interface CodegenTarget {
  enabled: boolean;
  output: string;
  /** optional flavor e.g. "freezed", "plain" */
  flavor?: string;
}

export type VariableType = "text" | "secret";

export interface SecretRef {
  type: "secret";
  name: string;
}

export interface TextVariable {
  type: "text";
  value: string;
}

export type Variable = SecretRef | TextVariable;

export interface EnvironmentFile {
  name: string;
  variables: Record<string, Variable>;
}

// ---------------------------------------------------------------------------
// Collections / endpoints
// ---------------------------------------------------------------------------

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export type AuthType =
  | "bearer"
  | "apiKey"
  | "basic"
  | "oauth2"
  | "custom";

export interface BearerAuth {
  type: "bearer";
  token: string; // may contain {{var}}
}

export interface ApiKeyAuth {
  type: "apiKey";
  in: "header" | "query";
  name: string;
  key: string;
}

export interface BasicAuth {
  type: "basic";
  username: string;
  password: string;
}

export interface CustomHeaderAuth {
  type: "custom";
  headers: Record<string, string>;
}

export type EndpointAuth =
  | BearerAuth
  | ApiKeyAuth
  | BasicAuth
  | CustomHeaderAuth;

export interface EndpointFile {
  name: string;
  method: HttpMethod;
  url: string; // may contain {{var}}
  auth?: EndpointAuth;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string | null;
  expect?: {
    status?: number;
    schema?: string; // path to schema file
  };
  after?: AfterStep[];
}

export interface AfterStep {
  set: Record<string, string>; // { varName: "$.jsonPath" }
}

export interface FolderFile {
  auth?: EndpointAuth;
  headers?: Record<string, string>;
}

export interface CollectionIndex {
  name: string;
  /** ordered list of endpoint file basenames (without .yaml) inside the folder */
  endpoints: string[];
  subFolders?: string[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ResolvedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface RunContext {
  /** fully-resolved env vars, secrets included (but secrets are NOT logged) */
  variables: Record<string, string>;
  secretNames: string[];
}

export interface RunResult {
  id: string; // snapshot id
  endpointId: string;
  timestamp: string; // ISO
  request: ResolvedRequest;
  status: number;
  headers: Record<string, string>;
  body: unknown; // parsed JSON when possible
  bodyRaw: string;
  timeMs: number;
  size: number;
  passed: boolean;
  failures: AssertionFailure[];
  /** redacted snapshot for storage/AI display */
  redacted: SnapshotRedacted;
}

export interface AssertionFailure {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface SnapshotRaw {
  id: string;
  endpointId: string;
  timestamp: string;
  request: ResolvedRequest;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyRaw: string;
  timeMs: number;
  size: number;
  passed: boolean;
  failures: AssertionFailure[];
  /** original secret values that were redacted (kept ONLY in memory, never persisted) */
  _secretValues?: Record<string, string>;
}

export interface SnapshotRedacted {
  id: string;
  endpointId: string;
  timestamp: string;
  request: ResolvedRequest;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timeMs: number;
  size: number;
  passed: boolean;
  failures: AssertionFailure[];
}

export interface SnapshotMeta {
  id: string;
  endpointId: string;
  timestamp: string;
  status: number;
  size: number;
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type ChangeKind =
  | "fieldAdded"
  | "fieldRemoved"
  | "fieldTypeChanged"
  | "nullableToNonNullable"
  | "nonNullableToNullable"
  | "enumValueAdded"
  | "enumValueRemoved"
  | "statusChanged"
  | "errorShapeChanged"
  | "renamed"
  | "unchanged";

export type BreakingLevel = "breaking" | "warning" | "nonBreaking" | "info";

export interface DiffChange {
  path: string;
  kind: ChangeKind;
  level: BreakingLevel;
  fromValue?: unknown;
  toValue?: unknown;
  description: string;
  /** confidence for rename detection */
  confidence?: number;
}

export interface DiffResult {
  fromId: string;
  toId: string;
  endpointId: string;
  breaking: boolean;
  changes: DiffChange[];
  summary: Record<BreakingLevel, number>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A simplified JSON-Schema-like object that Apilot infers. */
export interface ApilotSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, ApilotSchema>;
  items?: ApilotSchema;
  required: string[];
  enum?: unknown[];
  nullable: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface EndpointEntry {
  id: string; // e.g. "orders.list"
  collectionId: string;
  name: string;
  method: HttpMethod;
  url: string;
  /** relative path from project root */
  file: string;
}

export interface CollectionEntry {
  id: string;
  name: string;
  /** relative path from .apilot/collections */
  path: string;
}

export interface EnvironmentEntry {
  name: string;
  path: string;
}

export interface ProjectRegistry {
  project: ApilotProject;
  collections: CollectionEntry[];
  endpoints: EndpointEntry[];
  environments: EnvironmentEntry[];
}
