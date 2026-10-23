/**
 * Multi-project discovery.
 *
 * A folder can hold more than one Apilot project: the folder itself, and any
 * nested folder that has an `.apilot/apilot.yaml`. Opening a monorepo root
 * should show every project inside it — not just the root one — so Apilot
 * discovers them all and addresses each by its own id.
 *
 * `ProjectHub` is the shared action layer for that: one `Workspace` per
 * project, and one place that resolves an endpoint id to the right project.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EndpointEntry } from "./types.js";
import { Workspace } from "./workspace.js";

/** A folder that may hold an Apilot project. */
export interface ProjectEntry {
  /** Stable id: the path relative to the workspace folder ("." for the folder itself). */
  id: string;
  /** Display name — the project name from apilot.yaml, else the folder name. */
  name: string;
  /** Absolute path of the project folder. */
  root: string;
  /** Absolute path of the workspace folder this project was found in. */
  folder: string;
  /** Path relative to the workspace folder ("" for the folder itself). */
  relPath: string;
  /** True when the folder has `.apilot/apilot.yaml`. */
  hasApilot: boolean;
}

/** An endpoint together with the project it belongs to. */
export interface ProjectEndpoint {
  project: ProjectEntry;
  endpoint: EndpointEntry;
}

/** An endpoint resolved to its project and workspace. */
export interface ResolvedEndpoint {
  project: ProjectEntry;
  ws: Workspace;
  endpointId: string;
}

/**
 * What the tool layer needs to work across projects. `ProjectHub` implements
 * it for many projects; `singleProjectContext` wraps one `Workspace`.
 */
export interface ToolContext {
  readonly projects: ProjectEntry[];
  /** True when at least one project has an `.apilot` folder. */
  exists(): boolean;
  /** Find an endpoint and the project that owns it. */
  resolveEndpoint(endpointId: string, projectId?: string): ResolvedEndpoint;
  /** Every endpoint, across every project. */
  listEndpoints(projectId?: string): ProjectEndpoint[];
  /** The workspace of a project (or the default one). */
  workspace(projectId?: string): Workspace;
  /** The workspace of a project, creating `.apilot/` there if it is missing. */
  ensureProject(projectId?: string): Workspace;
  /** The workspace a command applies to when no project is given. */
  defaultWorkspace(): Workspace;
  /** Create `.apilot/` in a project folder. */
  initProject(name: string, projectId?: string): { initialized: string };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Directories never worth descending into. */
const IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "target",
  "Pods", "DerivedData", "__pycache__", ".venv", ".gradle", ".dart_tool",
  ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache", ".terraform",
]);

export interface DiscoverOptions {
  /** How many levels below a workspace folder to look. Default 4. */
  maxDepth?: number;
  /** Cap on directories scanned per folder, so a huge repo cannot stall startup. */
  maxDirs?: number;
}

/**
 * Find every folder under `folders` that can hold an Apilot project.
 *
 * The workspace folder itself is always included (even without `.apilot`) so
 * the user can still initialize it. Nested folders are included only when
 * they actually have a project, which keeps the list short in big repos.
 */
export function discoverProjects(folders: string[], opts: DiscoverOptions = {}): ProjectEntry[] {
  const maxDepth = opts.maxDepth ?? 4;
  const maxDirs = opts.maxDirs ?? 4000;
  const roots = uniqueRoots(folders);
  const multi = roots.length > 1;
  const out: ProjectEntry[] = [];
  const usedIds = new Set<string>();
  /** A folder can be reached from more than one workspace folder — list it once. */
  const seenRoots = new Set<string>();

  for (const folder of roots) {
    let scanned = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth || scanned >= maxDirs) return;
      scanned++;

      const rel = dir === folder ? "" : relative(folder, dir).split(sep).join("/");
      // Only the workspace folder itself and folders that really hold a
      // project are listed — the folders in between are just paths to them.
      if ((dir === folder || existsSync(join(dir, ".apilot", "apilot.yaml"))) && !seenRoots.has(dir)) {
        seenRoots.add(dir);
        out.push(makeEntry(folder, dir, rel, multi, usedIds));
      }

      let entries: Dirent[];
      try {
        // withFileTypes avoids a stat() per entry — this runs on every refresh.
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (!entry.isDirectory()) continue; // symlinks are skipped too, so no cycles
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      }
    };

    walk(folder, 0);
  }

  return out;
}

function uniqueRoots(folders: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of folders) {
    const norm = resolve(f);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function makeEntry(
  folder: string,
  dir: string,
  rel: string,
  multi: boolean,
  used: Set<string>
): ProjectEntry {
  const hasApilot = existsSync(join(dir, ".apilot", "apilot.yaml"));
  const base = rel === "" ? basename(folder) : multi ? `${basename(folder)}/${rel}` : rel;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return {
    id,
    name: (hasApilot ? projectName(dir) : undefined) ?? basename(dir),
    root: dir,
    folder,
    relPath: rel,
    hasApilot,
  };
}

/** The `name` from `.apilot/apilot.yaml`, when it has one. */
function projectName(dir: string): string | undefined {
  try {
    const raw = readFileSync(join(dir, ".apilot", "apilot.yaml"), "utf-8");
    const doc = parseYaml(raw) as { name?: unknown } | null;
    return typeof doc?.name === "string" && doc.name.trim() ? doc.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

export interface ProjectHubOptions {
  /** Build the workspace for a project — the editor injects a per-project keychain provider. */
  makeWorkspace?: (root: string) => Workspace;
  /** Request timeout in ms. */
  timeout?: number;
  /** How many snapshots to keep per endpoint. */
  retention?: number;
  /** How deep to look for nested projects. */
  discover?: DiscoverOptions;
}

/**
 * Every Apilot project inside one or more workspace folders, with a
 * `Workspace` for each. This is what the panel, the CLI, and the MCP server
 * all talk to.
 */
export class ProjectHub implements ToolContext {
  private _projects: ProjectEntry[];
  private readonly workspaces = new Map<string, Workspace>();
  private readonly make: (root: string) => Workspace;

  constructor(projects: ProjectEntry[], opts: ProjectHubOptions = {}) {
    this._projects = projects;
    this.make =
      opts.makeWorkspace ??
      ((root) => new Workspace(root, { timeout: opts.timeout, retention: opts.retention }));
  }

  /** Every project in the workspace. */
  get projects(): ProjectEntry[] {
    return this._projects;
  }

  /**
   * Replace the discovered projects (after a re-scan) while keeping the
   * workspaces already built for them.
   */
  setProjects(projects: ProjectEntry[]): void {
    this._projects = projects;
  }

  /** A hub for one folder and everything under it. */
  static forRoot(root: string, opts: ProjectHubOptions = {}): ProjectHub {
    return new ProjectHub(discoverProjects([root], opts.discover), opts);
  }

  /** True when at least one project has an `.apilot` folder. */
  exists(): boolean {
    return this.projects.some((p) => p.hasApilot);
  }

  /** The project a command applies to when none is named. */
  defaultProject(): ProjectEntry {
    return this.projects.find((p) => p.hasApilot) ?? this.projects[0]!;
  }

  /** Look a project up by id, relative path, or name. */
  project(id?: string): ProjectEntry {
    if (!id) return this.defaultProject();
    const hit = this.findProject(id);
    if (!hit) {
      throw new Error(
        `Project "${id}" not found. Available projects: ${this.projects.map((p) => p.id).join(", ") || "none"}.`
      );
    }
    return hit;
  }

  private findProject(id: string): ProjectEntry | undefined {
    const norm = id.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const byId = this.projects.find((p) => p.id === id);
    if (byId) return byId;
    const byRel = this.projects.find((p) => p.relPath === norm);
    if (byRel) return byRel;
    const byName = this.projects.find((p) => p.name === id);
    if (byName) return byName;
    const suffix = this.projects.filter((p) => p.id.endsWith(`/${norm}`));
    return suffix.length === 1 ? suffix[0] : undefined;
  }

  /** The workspace for a project (created on first use). */
  workspace(projectId?: string): Workspace {
    const p = this.project(projectId);
    let ws = this.workspaces.get(p.id);
    if (!ws) {
      ws = this.make(p.root);
      this.workspaces.set(p.id, ws);
    }
    return ws;
  }

  defaultWorkspace(): Workspace {
    return this.workspace();
  }

  /**
   * The workspace of a project, creating `.apilot/` there when the folder has
   * no project yet — so adding an endpoint to a fresh folder just works.
   */
  ensureProject(projectId?: string): Workspace {
    const project = this.project(projectId);
    const ws = this.workspace(project.id);
    if (!project.hasApilot) {
      ws.init(project.name);
      project.hasApilot = true;
    }
    return ws;
  }

  /**
   * Find an endpoint. `endpointId` may be qualified as `project::endpoint`.
   * Without a project the search covers every project, and an id that exists
   * in more than one is reported instead of guessed.
   */
  resolveEndpoint(endpointId: string, projectId?: string): ResolvedEndpoint {
    let pid = projectId;
    let eid = endpointId;
    const sepIndex = endpointId.indexOf("::");
    if (sepIndex > 0) {
      pid = endpointId.slice(0, sepIndex);
      eid = endpointId.slice(sepIndex + 2);
    }

    if (pid) {
      const project = this.project(pid);
      const ws = this.workspace(project.id);
      const { entry } = ws.endpoint(eid);
      return { project, ws, endpointId: entry.id };
    }

    const found: ResolvedEndpoint[] = [];
    for (const project of this.projects) {
      if (!project.hasApilot) continue;
      const ws = this.workspace(project.id);
      try {
        const { entry } = ws.endpoint(eid);
        found.push({ project, ws, endpointId: entry.id });
      } catch {
        // not in this project
      }
    }
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      throw new Error(
        `Endpoint "${eid}" exists in more than one project (${found.map((f) => f.project.id).join(", ")}). ` +
          `Pass project: "<id>" to choose one.`
      );
    }
    throw new Error(`Endpoint "${eid}" not found. Use list_endpoints to see available ids.`);
  }

  listEndpoints(projectId?: string): ProjectEndpoint[] {
    const list = projectId ? [this.project(projectId)] : this.projects.filter((p) => p.hasApilot);
    const out: ProjectEndpoint[] = [];
    for (const project of list) {
      const ws = this.workspace(project.id);
      for (const endpoint of ws.registry().endpoints) out.push({ project, endpoint });
    }
    return out;
  }

  /** Create `.apilot/` in a project folder (the first one without it, by default). */
  initProject(name: string, projectId?: string): { initialized: string } {
    const project = projectId
      ? this.project(projectId)
      : this.projects.find((p) => !p.hasApilot) ?? this.defaultProject();
    const ws = this.workspace(project.id);
    ws.init(name);
    project.hasApilot = true;
    return { initialized: ws.apilotDir };
  }
}

// ---------------------------------------------------------------------------
// One project, wrapped as a context
// ---------------------------------------------------------------------------

/**
 * Present a single `Workspace` through the same interface a hub uses, so the
 * tool layer works with either.
 */
export function singleProjectContext(ws: Workspace): ToolContext {
  const project = (): ProjectEntry => ({
    id: basename(ws.root),
    name: ws.project?.name ?? basename(ws.root),
    root: ws.root,
    folder: ws.root,
    relPath: "",
    hasApilot: ws.exists(),
  });
  return {
    get projects() {
      return [project()];
    },
    exists: () => ws.exists(),
    resolveEndpoint: (endpointId, projectId) => {
      if (projectId && projectId !== project().id && projectId !== project().name) {
        throw new Error(`Project "${projectId}" not found. Available projects: ${project().id}.`);
      }
      const { entry } = ws.endpoint(endpointId);
      return { project: project(), ws, endpointId: entry.id };
    },
    listEndpoints: () =>
      ws.registry().endpoints.map((endpoint) => ({ project: project(), endpoint })),
    workspace: (projectId) => {
      if (projectId && projectId !== project().id && projectId !== project().name) {
        throw new Error(`Project "${projectId}" not found. Available projects: ${project().id}.`);
      }
      return ws;
    },
    ensureProject: () => ws,
    defaultWorkspace: () => ws,
    initProject: (name) => {
      ws.init(name);
      return { initialized: ws.apilotDir };
    },
  };
}

/** True when the value already speaks the `ToolContext` interface. */
export function isToolContext(value: unknown): value is ToolContext {
  return !!value && typeof (value as ToolContext).resolveEndpoint === "function";
}
