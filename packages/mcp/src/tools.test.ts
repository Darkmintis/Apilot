import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { callTool, TOOLS } from "./tools";
import { ProjectHub, discoverProjects, schemaToJsonSchema } from "@apilot/core";
import type { Workspace } from "@apilot/core";

/** Minimal mock Workspace — each method is a vi.fn() so tests can assert calls
 * and override return values. The `exists` guard is true by default.
 */
function makeMockWs(overrides: Partial<Record<keyof Workspace, any>> = {}): Workspace {
  const endpoints = [
    { id: "orders.list", collectionId: "orders", name: "List orders", method: "GET", url: "{{baseUrl}}/orders", file: ".apilot/collections/orders/list.yaml" },
    { id: "orders.get", collectionId: "orders", name: "Get order", method: "GET", url: "{{baseUrl}}/orders/{{id}}", file: ".apilot/collections/orders/get.yaml" },
  ];
  const store = {
    latest: vi.fn(() => ({
      id: "snap-1", endpointId: "orders.list", timestamp: "2026-01-01T12:00:00.000Z",
      request: { method: "GET", url: "⟦REDACTED⟧/orders", headers: {}, body: null },
      status: 200, headers: {}, body: [{ id: 1, name: "Alice" }], timeMs: 42, size: 100,
      passed: true, failures: [], revision: 1,
    })),
    list: vi.fn(() => [
      { id: "snap-1", endpointId: "orders.list", timestamp: "2026-01-01T12:00:00.000Z", status: 200, size: 100, timeMs: 42, passed: true, revision: 1, baseline: true },
    ]),
    load: vi.fn(() => undefined),
  } as any;

  const ws: Record<string, any> = {
    exists: () => true,
    root: "/tmp/mock-project",
    apilotDir: "/tmp/mock-project/.apilot",
    project: { name: "test-api", defaultEnvironment: "dev", codegen: {} },
    registry: vi.fn(() => ({
      project: { name: "test-api", defaultEnvironment: "dev", codegen: {} },
      collections: [{ id: "orders", name: "Orders", path: ".apilot/collections/orders" }],
      endpoints,
      environments: [{ name: "dev", path: ".apilot/environments/dev.yaml" }],
    })),
    endpoint: vi.fn((id: string) => {
      const ep = endpoints.find((e) => e.id === id);
      if (!ep) throw new Error(`Endpoint "${id}" not found. Use list_endpoints to see available ids.`);
      return {
        entry: ep,
        definition: { name: ep.name, method: ep.method, url: ep.url, expect: { status: 200 } },
      };
    }),
    store,
    revisions: vi.fn(() => [
      { revision: 2, timestamp: "2026-01-01T11:00:00.000Z", summary: "added query page", definition: { name: "List", method: "GET", url: "{{baseUrl}}/orders", query: { page: "1" } } as any },
      { revision: 1, timestamp: "2026-01-01T10:00:00.000Z", summary: "First version", definition: { name: "List", method: "GET", url: "{{baseUrl}}/orders" } as any },
    ]),
    diffRevisions: vi.fn(() => ({
      from: { revision: 2, timestamp: "t1", summary: "v2", definition: { name: "List", method: "GET" } as any },
      to: { revision: 1, timestamp: "t0", summary: "v1", definition: { name: "List", method: "GET" } as any },
      changes: [{ field: "query.page", change: "added", to: "1" }],
    })),
    restoreRevision: vi.fn(() => 3),
    saveEndpoint: vi.fn(() => ({ id: "orders.list", file: ".apilot/collections/orders/list.yaml", revision: 1 })),
    deleteEndpoint: vi.fn(),
    run: vi.fn(() => Promise.resolve({
      endpointId: "orders.list",
      env: "dev",
      snapshot: { id: "snap-2", endpointId: "orders.list", timestamp: "2026-01-01T12:00:00.000Z", revision: 1,
        request: { method: "GET", url: "https://api.test/orders", headers: {}, body: null },
        status: 200, headers: {}, body: [{ id: 1, name: "Alice" }], timeMs: 30, size: 50,
        passed: true, failures: [] },
      diff: { fromId: "snap-1", toId: "snap-2", endpointId: "orders.list", breaking: false, changes: [],
        summary: { breaking: 0, warning: 0, nonBreaking: 0, info: 0 } },
      captured: { orderId: "7" },
    })),
    runAll: vi.fn(() => Promise.resolve({
      env: "dev",
      results: [
        { endpointId: "orders.list", name: "List orders", method: "GET", status: 200, timeMs: 30, passed: true, breaking: false },
        { endpointId: "orders.get", name: "Get order", method: "GET", status: 200, timeMs: 20, passed: true, breaking: false },
      ],
      passed: 2, failed: 0, breaking: 0,
    })),
    snapshot: vi.fn(() => ({
      id: "snap-1", endpointId: "orders.list", timestamp: "2026-01-01T12:00:00.000Z",
      request: { method: "GET", url: "https://api.test/orders", headers: {}, body: null },
      status: 200, headers: {}, body: [{ id: 1, name: "Alice" }], timeMs: 42, size: 100,
      passed: true, failures: [], revision: 1,
    })),
    snapshots: vi.fn(() => [
      { id: "snap-1", endpointId: "orders.list", timestamp: "2026-01-01T12:00:00.000Z", status: 200, size: 100, timeMs: 42, passed: true, revision: 1, baseline: true },
    ]),
    setBaseline: vi.fn(() => "snap-1"),
    deleteSnapshot: vi.fn(),
    diff: vi.fn(() => ({
      fromId: "snap-1", toId: "snap-2", endpointId: "orders.list", breaking: false, changes: [],
      summary: { breaking: 0, warning: 0, nonBreaking: 0, info: 0 },
    })),
    impact: vi.fn(() => ({ fields: ["name"], matches: [{ file: "lib/order.dart", line: 1, field: "name", text: "final String name;" }] })),
    schema: vi.fn(() => ({ type: "array" as const, items: { type: "object" as const, properties: { id: { type: "integer" as const, required: [], nullable: false }, name: { type: "string" as const, required: [], nullable: false } }, required: ["id", "name"], nullable: false }, required: [], nullable: false })),
    envName: vi.fn((name?: string) => name ?? "dev"),
    environment: vi.fn((name: string) => ({ name, variables: {} })),
    variables: vi.fn(() => Promise.resolve([
      { name: "baseUrl", type: "text", value: "https://api.test" },
      { name: "authToken", type: "secret", hasValue: true },
    ])),
    setVariable: vi.fn(() => Promise.resolve()),
    deleteVariable: vi.fn(() => Promise.resolve()),
    createEnvironment: vi.fn(),
    init: vi.fn(),
    ...overrides,
  };
  return ws as unknown as Workspace;
}

describe("MCP tools", () => {
  it("exports 24 tools", () => {
    expect(TOOLS).toHaveLength(24);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_endpoints");
    expect(names).toContain("get_endpoint");
    expect(names).toContain("run_endpoint");
    expect(names).toContain("diff_endpoint");
    expect(names).toContain("impact_report");
    expect(names).toContain("generate_code");
    expect(names).toContain("import_spec");
    expect(names).toContain("init_project");
  });

  it("throws when no project exists", () => {
    const ws = makeMockWs({ exists: () => false });
    return expect(callTool(ws, "list_endpoints", {})).rejects.toThrow(/No Apilot project/);
  });

  it("init_project works without a project", async () => {
    const ws = makeMockWs({ exists: () => false });
    const result = await callTool(ws, "init_project", { name: "my-api" });
    expect(ws.init).toHaveBeenCalledWith("my-api");
    expect(result).toEqual({ initialized: "/tmp/mock-project/.apilot" });
  });

  it("throws on unknown tool", () => {
    const ws = makeMockWs();
    return expect(callTool(ws, "not_a_real_tool", {})).rejects.toThrow(/Unknown tool/);
  });
});

describe("callTool — read tools", () => {
  it("list_endpoints returns project, envs, collections, and endpoints with snapshot counts", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "list_endpoints", {}) as any;
    expect(result.project).toBe("test-api");
    expect(result.defaultEnvironment).toBe("dev");
    expect(result.environments).toEqual(["dev"]);
    expect(result.collections).toHaveLength(1);
    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0]).toMatchObject({ id: "orders.list", method: "GET" });
    expect(ws.registry).toHaveBeenCalled();
  });

  it("list_endpoints can filter by collection", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "list_endpoints", { collectionId: "orders" }) as any;
    expect(result.endpoints).toHaveLength(2);
  });

  it("get_endpoint returns definition + latest response + revision", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "get_endpoint", { endpointId: "orders.list" }) as any;
    expect(result.id).toBe("orders.list");
    expect(result.definition.method).toBe("GET");
    expect(result.latestResponse).toBeDefined();
    expect(result.latestResponse.snapshotId).toBe("snap-1");
    expect(result.latestResponse.status).toBe(200);
    expect(result.revision).toBe(2);
  });

  it("get_endpoint with no response gives a hint", async () => {
    const ws = makeMockWs({ store: { latest: vi.fn(() => undefined), list: vi.fn(() => []), load: vi.fn() } as any });
    const result = await callTool(ws, "get_endpoint", { endpointId: "orders.list" }) as any;
    expect(result.latestResponse).toBeNull();
    expect(result.hint).toBe("No response saved yet — call run_endpoint.");
  });

  it("get_endpoint throws for missing endpoint", () => {
    const ws = makeMockWs();
    return expect(callTool(ws, "get_endpoint", { endpointId: "nope" })).rejects.toThrow(/not found/);
  });

  it("list_snapshots returns snapshot metadata", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "list_snapshots", { endpointId: "orders.list" });
    expect(ws.snapshots).toHaveBeenCalledWith("orders.list");
    expect((result as any[]).length).toBe(1);
    expect((result as any[])[0]!.id).toBe("snap-1");
    expect((result as any[])[0]!.baseline).toBe(true);
  });

  it("get_snapshot returns a single redacted snapshot", async () => {
    const ws = makeMockWs({ snapshot: vi.fn(() => ({ id: "x", endpointId: "e", timestamp: "t", request: { method: "GET", url: "", headers: {}, body: null }, status: 200, headers: {}, body: { ok: true }, timeMs: 5, size: 3, passed: true, failures: [] })) } as any);
    const result = await callTool(ws, "get_snapshot", { endpointId: "orders.list", snapshotId: "x" });
    expect((result as any).id).toBe("x");
  });

  it("get_snapshot defaults to latest", async () => {
    const ws = makeMockWs();
    await callTool(ws, "get_snapshot", { endpointId: "orders.list" });
    expect(ws.snapshot).toHaveBeenCalledWith("orders.list", undefined);
  });

  it("get_snapshot throws when no snapshots exist", () => {
    const ws = makeMockWs({ snapshot: vi.fn(() => { throw new Error("No snapshots for \"orders.list\" yet. Run it first."); }) } as any);
    return expect(callTool(ws, "get_snapshot", { endpointId: "orders.list" })).rejects.toThrow(/No snapshots/);
  });

  it("get_schema returns JSON schema + sample count", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "get_schema", { endpointId: "orders.list" }) as any;
    expect(result.endpointId).toBe("orders.list");
    expect(result.samples).toBe(1);
    const expectedSchema = schemaToJsonSchema(ws.schema("orders.list"));
    expect(result.schema).toEqual(expectedSchema);
  });

  it("list_revisions returns revisions without full definitions", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "list_revisions", { endpointId: "orders.list" }) as any;
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ revision: 2, summary: "added query page" });
    expect(result[0]).not.toHaveProperty("definition");
    expect(result[0]).toHaveProperty("method");
    expect(result[0]).toHaveProperty("url");
  });

  it("diff_revisions returns changes between revisions", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "diff_revisions", { endpointId: "orders.list" }) as any;
    expect(ws.diffRevisions).toHaveBeenCalledWith("orders.list", undefined, undefined);
    expect(result.changes).toBeDefined();
    expect(result.changes[0]).toMatchObject({ field: "query.page", change: "added" });
  });

  it("restore_revision returns new revision number", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "restore_revision", { endpointId: "orders.list", revision: 1 }) as any;
    expect(ws.restoreRevision).toHaveBeenCalledWith("orders.list", 1);
    expect(result).toEqual({ endpointId: "orders.list", revision: 3 });
  });
});

describe("callTool — write tools", () => {
  it("add_endpoint creates an endpoint", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "add_endpoint", {
      collection: "orders", name: "Create", method: "POST", url: "{{baseUrl}}/orders",
    }) as any;
    expect(ws.saveEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "orders", name: "Create", method: "POST" })
    );
    expect(result.id).toBe("orders.list");
  });

  it("update_endpoint merges into existing definition", async () => {
    const ws = makeMockWs();
    await callTool(ws, "update_endpoint", {
      endpointId: "orders.list", query: { page: "2" },
    });
    expect(ws.saveEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "orders.list", query: { page: "2" } })
    );
  });

  it("update_endpoint can null out fields", async () => {
    const ws = makeMockWs();
    await callTool(ws, "update_endpoint", { endpointId: "orders.list", body: null });
    expect(ws.saveEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: "orders.list", body: undefined })
    );
  });

  it("delete_endpoint removes the endpoint", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "delete_endpoint", { endpointId: "orders.list" }) as any;
    expect(ws.deleteEndpoint).toHaveBeenCalledWith("orders.list");
    expect(result).toEqual({ deleted: "orders.list" });
  });
});

describe("callTool — running", () => {
  it("run_endpoint returns redacted snapshot + diff + captured", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "run_endpoint", { endpointId: "orders.list", env: "dev" }) as any;
    expect(ws.run).toHaveBeenCalledWith("orders.list", "dev");
    expect(result.endpointId).toBe("orders.list");
    expect(result.status).toBe(200);
    expect(result.snapshotId).toBe("snap-2");
    expect(result.passed).toBe(true);
    expect(result.captured).toEqual({ orderId: "7" });
  });

  it("run_endpoint without env still works (uses default)", async () => {
    const ws = makeMockWs();
    await callTool(ws, "run_endpoint", { endpointId: "orders.list" });
    expect(ws.run).toHaveBeenCalledWith("orders.list", undefined);
  });

  it("run_collection returns pass/fail summary", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "run_collection", { collectionId: "orders", env: "dev" }) as any;
    expect(ws.runAll).toHaveBeenCalledWith("orders", "dev");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.breaking).toBe(0);
    expect(result.results).toHaveLength(2);
  });

  it("run_collection without collection runs everything", async () => {
    const ws = makeMockWs();
    await callTool(ws, "run_collection", { env: "dev" });
    expect(ws.runAll).toHaveBeenCalledWith(undefined, "dev");
  });
});

describe("callTool — baselines & diffs", () => {
  it("set_baseline accepts the latest snapshot", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "set_baseline", { endpointId: "orders.list" }) as any;
    expect(ws.setBaseline).toHaveBeenCalledWith("orders.list", undefined);
    expect(result.baseline).toBe("snap-1");
  });

  it("set_baseline accepts a specific snapshot id", async () => {
    const ws = makeMockWs();
    await callTool(ws, "set_baseline", { endpointId: "orders.list", snapshotId: "snap-999" });
    expect(ws.setBaseline).toHaveBeenCalledWith("orders.list", "snap-999");
  });

  it("delete_snapshot removes a non-baseline snapshot", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "delete_snapshot", { endpointId: "orders.list", snapshotId: "snap-1" }) as any;
    expect(ws.deleteSnapshot).toHaveBeenCalledWith("orders.list", "snap-1");
    expect(result).toEqual({ deleted: "snap-1" });
  });

  it("diff_endpoint returns classified changes", async () => {
    const ws = makeMockWs({ diff: vi.fn(() => ({
      fromId: "snap-1", toId: "snap-2", endpointId: "orders.list", breaking: true,
      changes: [{ path: "$.name", kind: "fieldRemoved", level: "breaking", description: "Field removed" }],
      summary: { breaking: 1, warning: 0, nonBreaking: 0, info: 0 },
    })) as any });
    const result = await callTool(ws, "diff_endpoint", { endpointId: "orders.list" }) as any;
    expect(result.breaking).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.summary.breaking).toBe(1);
  });

  it("impact_report returns code matches with files/lines", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "impact_report", { endpointId: "orders.list" }) as any;
    expect(ws.diff).toHaveBeenCalled();
    expect(ws.impact).toHaveBeenCalled();
    expect(result.changedFields).toContain("name");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ file: "lib/order.dart", line: 1 });
  });
});

describe("callTool — variable/environment management", () => {
  it("list_variables returns text values and secret hasValue only", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "list_variables", { env: "dev" }) as any;
    expect(result.env).toBe("dev");
    expect(result.variables).toHaveLength(2);
    expect(result.variables[0]).toMatchObject({ name: "baseUrl", type: "text", value: "https://api.test" });
    expect(result.variables[1]).toMatchObject({ name: "authToken", type: "secret", hasValue: true });
    expect(result.variables[1].value).toBeUndefined();
  });

  it("set_variable for text saves the value", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "set_variable", { env: "dev", name: "baseUrl", type: "text", value: "https://prod.example.com" }) as any;
    expect(ws.setVariable).toHaveBeenCalledWith("dev", "baseUrl", "text", "https://prod.example.com");
    expect(result).toEqual({ env: "dev", name: "baseUrl", type: "text" });
  });

  it("set_variable for secret refuses a value", () => {
    const ws = makeMockWs();
    return expect(callTool(ws, "set_variable", { env: "dev", name: "token", type: "secret", value: "abc123" })).rejects.toThrow(/can't be set/);
  });

  it("set_variable for secret without value just declares it", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "set_variable", { env: "dev", name: "newToken", type: "secret" }) as any;
    expect(ws.setVariable).toHaveBeenCalledWith("dev", "newToken", "secret", undefined);
    expect(result.type).toBe("secret");
  });

  it("delete_variable removes the variable", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "delete_variable", { env: "dev", name: "oldVar" }) as any;
    expect(ws.deleteVariable).toHaveBeenCalledWith("dev", "oldVar");
    expect(result).toEqual({ env: "dev", deleted: "oldVar" });
  });

  it("create_environment creates a new env", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "create_environment", { name: "staging", copyFrom: "dev" }) as any;
    expect(ws.createEnvironment).toHaveBeenCalledWith("staging", "dev");
    expect(result).toEqual({ created: "staging" });
  });
});

describe("callTool — codegen & import", () => {
  it("generate_code with write:false returns file list without writing", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "generate_code", {
      endpointId: "orders.list", language: "typescript", write: false,
    }) as any;
    expect(result.files).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it("generate_code supports all languages", async () => {
    const ws = makeMockWs();
    for (const language of ["dart", "typescript", "kotlin", "swift"]) {
      const result = await callTool(ws, "generate_code", {
        endpointId: "orders.list", language, write: false,
      }) as any;
      expect(result.files).toBeDefined();
    }
  });

  it("generate_code throws on unsupported language", () => {
    const ws = makeMockWs();
    return expect(callTool(ws, "generate_code", {
      endpointId: "orders.list", language: "rust", write: false,
    })).rejects.toThrow();
  });

  it("import_spec parses a curl command into an endpoint", async () => {
    const ws = makeMockWs();
    const curl = "curl https://api.example.com/posts?page=1 -H 'Authorization: Bearer {{authToken}}'";
    const result = await callTool(ws, "import_spec", {
      source: "curl", content: curl, collection: "orders", env: "dev",
    }) as any;
    expect(result).toBeDefined();
    expect(ws.saveEndpoint).toHaveBeenCalled();
  });

  it("import_spec without env still works", async () => {
    const ws = makeMockWs();
    const result = await callTool(ws, "import_spec", {
      source: "curl", content: "curl https://api.example.com/health",
    });
    expect(result).toBeDefined();
  });

  it("import_spec throws on empty content", () => {
    const ws = makeMockWs();
    return expect(callTool(ws, "import_spec", {
      source: "curl", content: "", collection: "orders",
    })).rejects.toThrow();
  });

  it("clips response body over 60_000 chars", async () => {
    const big = "x".repeat(70_000);
    const ws = makeMockWs({ store: { latest: vi.fn(() => ({ id: "snap-1", endpointId: "orders.list", timestamp: "t", request: { method: "GET", url: "", headers: {}, body: null }, status: 200, headers: {}, body: big, timeMs: 42, size: 70000, passed: true, failures: [] })), list: vi.fn(() => []), load: vi.fn() } } as any);
    const result = await callTool(ws, "get_endpoint", { endpointId: "orders.list" }) as any;
    expect(result.latestResponse.body.truncated).toBe(true);
    expect(result.latestResponse.body.preview).toHaveLength(60_000);
  });
});

// ---------------------------------------------------------------------------
// Several projects in one workspace
// ---------------------------------------------------------------------------

describe("callTool — multiple projects", () => {
  const temps: string[] = [];

  /** A workspace root with two nested Apilot projects. */
  function makeHub() {
    const root = mkdtempSync(join(tmpdir(), "apilot-multi-"));
    temps.push(root);
    for (const [dir, name] of [["services/api", "API"], ["apps/web", "Web"]] as const) {
      const project = join(root, dir);
      mkdirSync(join(project, ".apilot", "collections", "orders"), { recursive: true });
      writeFileSync(join(project, ".apilot", "apilot.yaml"), toYaml({ name, defaultEnvironment: "dev" }));
      writeFileSync(
        join(project, ".apilot", "collections", "orders", "list.yaml"),
        toYaml({ name: "List orders", method: "GET", url: "{{baseUrl}}/orders" })
      );
    }
    return new ProjectHub(discoverProjects([root]));
  }

  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  it("lists every project with its endpoints", async () => {
    const hub = makeHub();
    const result = (await callTool(hub, "list_endpoints", {})) as any;
    const ids = result.projects.filter((p: any) => p.hasApilot).map((p: any) => p.id).sort();
    expect(ids).toEqual(["apps/web", "services/api"]);
    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints.every((e: any) => !!e.project)).toBe(true);
  });

  it("resolves an endpoint in the project that owns it", async () => {
    const hub = makeHub();
    const result = (await callTool(hub, "get_endpoint", { endpointId: "orders.list", project: "apps/web" })) as any;
    expect(result.project).toBe("apps/web");
    expect(result.definition.method).toBe("GET");
  });

  it("accepts a project-qualified endpoint id", async () => {
    const hub = makeHub();
    const result = (await callTool(hub, "get_endpoint", { endpointId: "services/api::orders.list" })) as any;
    expect(result.project).toBe("services/api");
  });

  it("says which projects to choose from when an id is ambiguous", async () => {
    const hub = makeHub();
    await expect(callTool(hub, "get_endpoint", { endpointId: "orders.list" })).rejects.toThrow(/more than one project/);
  });

  it("filters endpoints by project", async () => {
    const hub = makeHub();
    const result = (await callTool(hub, "list_endpoints", { project: "apps/web" })) as any;
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].project).toBe("apps/web");
  });

  it("initializes a folder that has no project yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "apilot-multi-"));
    temps.push(root);
    const hub = new ProjectHub(discoverProjects([root]));
    expect(hub.exists()).toBe(false);
    const result = (await callTool(hub, "init_project", { name: "Root API" })) as any;
    expect(result.initialized).toBe(join(root, ".apilot"));
    expect(hub.exists()).toBe(true);
  });
});
