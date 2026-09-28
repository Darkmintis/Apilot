// Type definitions shared between the extension host and the webview UI.
// These mirror @apilot/core types but are self-contained so the webview
// bundle doesn't need to bundle the entire core package.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface EndpointEntry {
  id: string;
  collectionId: string;
  name: string;
  method: HttpMethod;
  url: string;
  file: string;
}

export interface CollectionEntry {
  id: string;
  name: string;
  path: string;
}

export interface EnvironmentEntry {
  name: string;
  path: string;
}

export interface ProjectRegistry {
  project: { name: string; defaultEnvironment?: string; codegen?: Record<string, unknown> };
  collections: CollectionEntry[];
  endpoints: EndpointEntry[];
  environments: EnvironmentEntry[];
}

export interface ResolvedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface AssertionFailure {
  field: string;
  message: string;
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

export type BreakingLevel = "breaking" | "warning" | "nonBreaking" | "info";

export interface DiffChange {
  path: string;
  kind: string;
  level: BreakingLevel;
  fromValue?: unknown;
  toValue?: unknown;
  description: string;
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

// Message protocol between extension host and webview
export type WebviewMessage =
  | { type: "init"; data: InitData }
  | { type: "runResult"; data: RunResultMessage }
  | { type: "registry"; data: ProjectRegistry }
  | { type: "snapshots"; data: { endpointId: string; snapshots: SnapshotMeta[] } }
  | { type: "diff"; data: DiffResult }
  | { type: "codeGenerated"; data: { language: string; code: string } };

export interface InitData {
  registry: ProjectRegistry;
  environments: EnvironmentEntry[];
  workspaceRoot: string;
  hasApilotProject: boolean;
}

export interface RunResultMessage {
  endpointId: string;
  snapshot: SnapshotRedacted;
  ok: boolean;
}

export interface SnapshotMeta {
  id: string;
  endpointId: string;
  timestamp: string;
  status: number;
  size: number;
  passed: boolean;
}

export interface EndpointFile {
  name: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | null;
  auth?: { type: string; [key: string]: unknown };
  expect?: { status?: number; schema?: string };
  after?: Array<{ set: Record<string, string> }>;
}

export interface EnvironmentFile {
  name: string;
  variables: Record<string, { type: "text" | "secret"; value?: string; name?: string }>;
}

export interface VariableDef {
  type: "text" | "secret";
  value?: string;
  name?: string;
}
