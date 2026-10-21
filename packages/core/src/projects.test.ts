import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import {
  ProjectHub,
  discoverProjects,
  singleProjectContext,
  type ProjectEntry,
} from "../src/index";

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "apilot-projects-"));
  roots.push(dir);
  return dir;
}

/** Create a folder that holds an Apilot project. */
function makeProject(dir: string, name = "My API", endpoints: string[] = []): void {
  mkdirSync(join(dir, ".apilot"), { recursive: true });
  writeFileSync(join(dir, ".apilot", "apilot.yaml"), toYaml({ name, defaultEnvironment: "dev" }));
  mkdirSync(join(dir, ".apilot", "collections", "orders"), { recursive: true });
  for (const ep of endpoints) {
    writeFileSync(
      join(dir, ".apilot", "collections", "orders", `${ep}.yaml`),
      toYaml({ name: ep, method: "GET", url: "{{baseUrl}}/orders" })
    );
  }
}

afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("discoverProjects", () => {
  it("always includes the workspace folder, even without .apilot", () => {
    const root = tempRoot();
    const projects = discoverProjects([root]);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.hasApilot).toBe(false);
    expect(projects[0]!.root).toBe(root);
  });

  it("finds nested projects and marks them as initialized", () => {
    const root = tempRoot();
    makeProject(join(root, "services", "api"), "Service API");
    makeProject(join(root, "apps", "web"), "Web App");

    const projects = discoverProjects([root]);
    const withApilot = projects.filter((p) => p.hasApilot);
    expect(withApilot.map((p) => p.relPath).sort()).toEqual(["apps/web", "services/api"]);
    expect(withApilot.find((p) => p.relPath === "services/api")!.name).toBe("Service API");
  });

  it("does not descend into node_modules or hidden folders", () => {
    const root = tempRoot();
    makeProject(join(root, "node_modules", "pkg"));
    makeProject(join(root, ".hidden", "pkg"));
    makeProject(join(root, "real"));

    const projects = discoverProjects([root]).filter((p) => p.hasApilot);
    expect(projects.map((p) => p.relPath)).toEqual(["real"]);
  });

  it("stops at maxDepth", () => {
    const root = tempRoot();
    makeProject(join(root, "a", "b", "c", "d"));
    const shallow = discoverProjects([root], { maxDepth: 2 }).filter((p) => p.hasApilot);
    expect(shallow).toHaveLength(0);
    const deep = discoverProjects([root], { maxDepth: 5 }).filter((p) => p.hasApilot);
    expect(deep.map((p) => p.relPath)).toEqual(["a/b/c/d"]);
  });

  it("gives every workspace folder its own project", () => {
    const a = tempRoot();
    const b = tempRoot();
    makeProject(a);
    makeProject(b);
    const projects = discoverProjects([a, b]);
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((p) => p.id)).size).toBe(2);
  });

  it("lists a folder once when two workspace folders overlap", () => {
    const root = tempRoot();
    const nested = join(root, "sub");
    makeProject(root);
    makeProject(nested);
    // "/sub" is inside "/root", and both are workspace folders.
    const projects = discoverProjects([root, nested]);
    const roots = projects.map((p) => p.root);
    expect(new Set(roots).size).toBe(roots.length);
    expect(projects.filter((p) => p.root === nested)).toHaveLength(1);
  });
});

describe("ProjectHub", () => {
  function twoProjects() {
    const root = tempRoot();
    makeProject(join(root, "services", "api"), "API", ["list"]);
    makeProject(join(root, "apps", "web"), "Web", ["list"]);
    return { root, hub: new ProjectHub(discoverProjects([root])) };
  }

  it("resolves an endpoint to the project that owns it", () => {
    const { hub } = twoProjects();
    const resolved = hub.resolveEndpoint("orders.list", "apps/web");
    expect(resolved.project.id).toBe("apps/web");
    expect(resolved.endpointId).toBe("orders.list");
  });

  it("reports an endpoint that exists in more than one project", () => {
    const { hub } = twoProjects();
    expect(() => hub.resolveEndpoint("orders.list")).toThrow(/more than one project/);
  });

  it("accepts a project-qualified id", () => {
    const { hub } = twoProjects();
    const resolved = hub.resolveEndpoint("services/api::orders.list");
    expect(resolved.project.id).toBe("services/api");
  });

  it("lists endpoints across every project", () => {
    const { hub } = twoProjects();
    const all = hub.listEndpoints();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.project.id))).toEqual(new Set(["apps/web", "services/api"]));
  });

  it("initializes the folder that has no project yet", () => {
    const root = tempRoot();
    makeProject(join(root, "services", "api"));
    const hub = new ProjectHub(discoverProjects([root]));
    expect(hub.exists()).toBe(true);

    const result = hub.initProject("Root API");
    expect(existsSync(join(root, ".apilot", "apilot.yaml"))).toBe(true);
    expect(result.initialized).toBe(join(root, ".apilot"));
  });

  it("initializes a named project", () => {
    const root = tempRoot();
    makeProject(join(root, "services", "api"));
    const hub = new ProjectHub(discoverProjects([root]));
    hub.initProject("Web API", "services/api");
    // It already had one — init is safe and keeps the existing files.
    expect(existsSync(join(root, "services", "api", ".apilot", "apilot.yaml"))).toBe(true);
  });

  it("reports an unknown project", () => {
    const { hub } = twoProjects();
    expect(() => hub.project("nope")).toThrow(/not found/);
  });

  it("initializes a project on demand when something is added to it", () => {
    const root = tempRoot();
    const hub = new ProjectHub(discoverProjects([root]));
    expect(hub.exists()).toBe(false);

    hub.ensureProject();
    expect(existsSync(join(root, ".apilot", "apilot.yaml"))).toBe(true);
    expect(hub.exists()).toBe(true);
  });
});

describe("singleProjectContext", () => {
  it("presents one workspace through the multi-project interface", () => {
    const root = tempRoot();
    makeProject(root, "Solo", ["list"]);
    const hub = new ProjectHub(discoverProjects([root]));
    const ctx = singleProjectContext(hub.workspace());

    expect(ctx.exists()).toBe(true);
    expect(ctx.projects).toHaveLength(1);
    expect(ctx.listEndpoints().map((e) => e.endpoint.id)).toEqual(["orders.list"]);
    expect(ctx.resolveEndpoint("orders.list").endpointId).toBe("orders.list");
  });
});
