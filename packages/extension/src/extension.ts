/**
 * Apilot — VS Code / Cursor extension.
 *
 * GUI-first: the Apilot panel is the main surface. Everything it does goes
 * through the same Workspace + tool table the AI uses, so the AI can do
 * whatever the user can (except see or enter secret values).
 *
 * A workspace can hold several Apilot projects — the folder itself, and any
 * nested folder with an `.apilot/apilot.yaml`. All of them are discovered and
 * shown, each addressed by its own project id.
 *
 * On open, with no "connect" step:
 *  - AI skills are written to the project (.cursor/skills, .claude/skills, Copilot instructions)
 *  - the MCP server is registered through the editor's API
 *  - a localhost bridge (random per-session token) lets that MCP server run
 *    requests here, with secrets from the OS keychain
 */

import * as vscode from "vscode";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProjectHub,
  Workspace,
  discoverProjects,
  type DiffResult,
  type ProjectEntry,
  type RunOutcome,
  type SecretProvider,
} from "@apilot/core";
import { callTool } from "@apilot/mcp/tools";
import { aiFiles, writeAiFiles, MARKER } from "@apilot/skill";

let ext: ApilotExtension | undefined;

/** A row in the sidebar tree. */
export interface TreeRow {
  kind: "project" | "collection" | "endpoint";
  label: string;
  id?: string;
  project?: string;
}

/** What the extension exposes to other extensions and to its own tests. */
export interface ApilotApi {
  /** Every Apilot project found in the workspace. */
  projects(): { id: string; name: string; root: string; hasApilot: boolean }[];
  /** The rows the sidebar shows at the top level. */
  topLevel(): TreeRow[];
}

export function activate(ctx: vscode.ExtensionContext): ApilotApi {
  ext = new ApilotExtension(ctx);
  return {
    projects: () => {
      ext!.rediscover();
      return ext!.hub.projects.map((p) => ({ id: p.id, name: p.name, root: p.root, hasApilot: p.hasApilot }));
    },
    topLevel: () => ext!.topLevel(),
  };
}

export function deactivate(): void {
  ext?.dispose();
}

class KeychainSecrets implements SecretProvider {
  constructor(private readonly store: vscode.SecretStorage, private readonly root: string) {}
  private key(env: string, name: string) {
    return `apilot:${this.root}:${env}:${name}`;
  }
  get(env: string, name: string) {
    return Promise.resolve(this.store.get(this.key(env, name)));
  }
  async set(env: string, name: string, value: string) {
    await this.store.store(this.key(env, name), value);
  }
  async delete(env: string, name: string) {
    await this.store.delete(this.key(env, name));
  }
  async prompt(env: string, names: string[]) {
    for (const name of names) {
      const value = await vscode.window.showInputBox({
        title: `Apilot — secret for "${env}"`,
        prompt: `Enter ${name}. It is stored in your OS keychain, never in files.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (value) await this.set(env, name, value);
    }
  }
}

interface Health {
  status?: number;
  state: "none" | "passed" | "failed" | "breaking" | "changed";
}

class ApilotExtension implements vscode.Disposable {
  /** Every Apilot project found inside the workspace folders. */
  readonly hub: ProjectHub;
  private panel: vscode.WebviewPanel | undefined;
  private bridge: http.Server | undefined;
  private mcpRegistration: vscode.Disposable | undefined;
  private readonly tree = new EndpointTree(this);
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  /** When the project list was last re-scanned (see `rediscover`). */
  private lastScan = 0;
  private watchers: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.hub = new ProjectHub([], {
      makeWorkspace: (root) =>
        new Workspace(root, { secrets: new KeychainSecrets(ctx.secrets, root), timeout: this.config<number>("timeout") }),
    });
    this.rediscover();
    this.watchProjects();

    const treeView = vscode.window.createTreeView("apilot.endpoints", { treeDataProvider: this.tree, showCollapseAll: true });
    const cmd = (id: string, fn: (...a: any[]) => unknown) => vscode.commands.registerCommand(id, async (...a: any[]) => {
      try {
        await fn(...a);
      } catch (err) {
        vscode.window.showErrorMessage(`Apilot: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.disposables.push(
      treeView,
      cmd("apilot.open", (arg?: string | EndpointItem) => {
        if (arg && typeof arg === "object") return this.openPanel({ endpointId: arg.endpointId, project: arg.project.id });
        if (typeof arg === "string") return this.openPanel({ endpointId: arg });
        return this.openPanel();
      }),
      cmd("apilot.init", (projectId?: string) => this.init(projectId)),
      cmd("apilot.newEndpoint", () => this.openPanel({ view: "new" })),
      cmd("apilot.import", () => this.openPanel({ view: "import" })),
      cmd("apilot.environments", () => this.openPanel({ view: "environments" })),
      cmd("apilot.runAll", () => this.openPanel({ view: "runAll", autorun: true })),
      cmd("apilot.runEndpoint", (item?: EndpointItem | string) => this.runFromTree(item)),
      cmd("apilot.openFile", (item?: EndpointItem) => item && this.openFile(item.file, undefined, item.project.id)),
      cmd("apilot.refresh", () => {
        this.rediscover(true);
        this.refresh();
      }),
      cmd("apilot.setupAi", () => this.setupAi(true)),
      cmd("apilot.removeAi", () => this.removeAi()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rediscover(true);
        this.watchProjects();
        this.refresh();
      }),
      vscode.window.registerWebviewPanelSerializer("apilot.panel", {
        deserializeWebviewPanel: async (panel) => this.attachPanel(panel),
      })
    );

    this.onProjectReady();
  }

  config<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("apilot").get<T>(key);
  }

  /** Every workspace folder open in the editor. */
  get folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  get hasProject(): boolean {
    return this.hub.exists();
  }

  /** The folder the bridge and the skills live in. */
  get bridgeRoot(): string | undefined {
    return this.folders[0];
  }

  /**
   * Re-scan the workspace folders for Apilot projects.
   *
   * The file watcher below is the fast path, but it is not guaranteed —
   * on CI it can fall back to polling, or silently stop if the OS runs out
   * of watch handles. Every surface that reads the project list therefore
   * re-scans on demand, throttled so a burst of changes costs one walk.
   */
  rediscover(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastScan < 500) return;
    this.lastScan = now;
    this.hub.setProjects(discoverProjects(this.folders));
  }

  /**
   * Watch every `.apilot` folder in the workspace. A folder appearing or
   * disappearing changes the project list, so it triggers a re-scan.
   */
  private watchProjects(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const folder of this.folders) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), "**/.apilot/**"));
      const onChange = (uri: vscode.Uri) => {
        if (uri.fsPath.includes(`${path.sep}.local${path.sep}`)) return;
        if (uri.fsPath.endsWith(`${path.sep}apilot.yaml`)) this.rediscover(true);
        this.scheduleRefresh();
      };
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watchers.push(watcher);
    }
  }

  /** The project the panel is showing. */
  activeProject(): ProjectEntry {
    const stored = this.ctx.workspaceState.get<string>("apilot.activeProject");
    if (stored) {
      try {
        return this.hub.project(stored);
      } catch {
        /* the folder went away — fall back */
      }
    }
    return this.hub.defaultProject();
  }

  /** The environment selected for a project. */
  envFor(projectId: string): string | undefined {
    const map = this.ctx.workspaceState.get<Record<string, string>>("apilot.env") ?? {};
    const stored = map[projectId];
    if (stored) {
      try {
        const names = this.hub.workspace(projectId).registry().environments.map((e) => e.name);
        if (names.includes(stored)) return stored;
      } catch {
        /* fall through */
      }
    }
    const reg = this.hub.workspace(projectId).registry();
    return reg.project.defaultEnvironment ?? reg.environments[0]?.name;
  }

  private async setEnv(projectId: string, env: string): Promise<void> {
    const map = this.ctx.workspaceState.get<Record<string, string>>("apilot.env") ?? {};
    map[projectId] = env;
    await this.ctx.workspaceState.update("apilot.env", map);
  }

  /** Called on activation and after `init`: everything that needs a project. */
  private onProjectReady(): void {
    vscode.commands.executeCommand("setContext", "apilot.hasProject", this.hasProject);
    if (!this.hasProject || !this.bridgeRoot) return;
    ensureLocalIgnored(this.bridgeRoot);
    for (const p of this.hub.projects) if (p.hasApilot) ensureLocalIgnored(p.root);
    this.startBridge().catch((err) => console.error("[apilot] bridge failed", err));
    if (this.config<boolean>("ai.autoSetup") !== false && !this.ctx.workspaceState.get("apilot.aiRemoved")) this.setupAi(false);
  }

  private async init(projectId?: string): Promise<void> {
    if (!this.folders.length) throw new Error("Open a folder first.");
    const project = projectId
      ? this.hub.project(projectId)
      : this.hub.projects.find((p) => !p.hasApilot) ?? this.hub.defaultProject();
    const name = await vscode.window.showInputBox({
      title: "Apilot — new project",
      prompt: `Initialize Apilot in "${project.root}"`,
      value: path.basename(project.root),
    });
    if (name === undefined) return;
    this.hub.initProject(name || "my-api", project.id);
    this.rediscover(true);
    await this.ctx.workspaceState.update("apilot.activeProject", project.id);
    this.onProjectReady();
    this.refresh();
    this.openPanel();
  }

  // -------------------------------------------------------------------------
  // AI setup: skills + MCP registration (no manual "connect")
  // -------------------------------------------------------------------------

  private setupAi(manual: boolean): void {
    const root = this.bridgeRoot;
    if (!root) return;
    const written = writeAiFiles(root);
    const how = this.registerMcp();
    if (manual) this.ctx.workspaceState.update("apilot.aiRemoved", undefined);
    if (manual || (written.length && !this.ctx.workspaceState.get("apilot.aiNotified"))) {
      this.ctx.workspaceState.update("apilot.aiNotified", true);
      const mcp = how === "none" ? "MCP needs VS Code 1.101+ or Cursor — skills still work." : `MCP server registered with ${how}.`;
      vscode.window.showInformationMessage(`Apilot set up your AI assistant: skills added for Cursor, Claude Code, and Copilot. ${mcp}`, "Open Apilot", "Undo").then((pick) => {
        if (pick === "Open Apilot") this.openPanel();
        if (pick === "Undo") this.removeAi();
      });
    }
  }

  private removeAi(): void {
    const root = this.bridgeRoot;
    if (!root) return;
    for (const f of aiFiles()) {
      const full = path.join(root, f.path);
      try {
        if (fs.readFileSync(full, "utf-8").includes(MARKER)) fs.rmSync(full);
      } catch {
        /* not there */
      }
    }
    this.mcpRegistration?.dispose();
    this.mcpRegistration = undefined;
    this.ctx.workspaceState.update("apilot.aiRemoved", true);
    vscode.window.showInformationMessage("Apilot AI setup removed. Run “Apilot: Set Up AI Assistant” to add it back.");
  }

  private registerMcp(): "Cursor" | "VS Code" | "none" {
    const root = this.bridgeRoot;
    if (this.mcpRegistration || !root) return this.mcpRegistration ? (vscode.env.appName.includes("Cursor") ? "Cursor" : "VS Code") : "none";
    const server = {
      command: process.execPath,
      args: [this.ctx.asAbsolutePath(path.join("dist", "mcp.mjs"))],
      env: { ELECTRON_RUN_AS_NODE: "1", APILOT_PROJECT_ROOT: root },
    };
    const api = vscode as any;
    try {
      if (api.cursor?.mcp?.registerServer) {
        api.cursor.mcp.registerServer({ name: "apilot", server });
        this.mcpRegistration = { dispose: () => api.cursor.mcp.unregisterServer?.("apilot") };
        return "Cursor";
      }
      if (api.lm?.registerMcpServerDefinitionProvider && api.McpStdioServerDefinition) {
        const changed = new vscode.EventEmitter<void>();
        this.mcpRegistration = vscode.Disposable.from(
          changed,
          api.lm.registerMcpServerDefinitionProvider("apilot.mcp", {
            onDidChangeMcpServerDefinitions: changed.event,
            provideMcpServerDefinitions: () => [new api.McpStdioServerDefinition("Apilot", server.command, server.args, server.env, this.ctx.extension.packageJSON.version)],
          })
        );
        return "VS Code";
      }
    } catch (err) {
      console.error("[apilot] MCP registration failed", err);
    }
    return "none";
  }

  // -------------------------------------------------------------------------
  // Bridge: the MCP process forwards tool calls here (keychain secrets, live GUI)
  // -------------------------------------------------------------------------

  private async startBridge(): Promise<void> {
    const root = this.bridgeRoot;
    if (this.bridge || !root) return;
    const token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== "POST" || req.url !== "/call" || auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
        return reply(401, { error: "unauthorized" });
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 5_000_000) req.destroy();
      });
      req.on("end", async () => {
        try {
          const { name, args } = JSON.parse(body) as { name: string; args: Record<string, unknown> };
          const result = await this.tool(name, args ?? {});
          reply(200, { result });
        } catch (err) {
          reply(200, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    });
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    this.bridge = server;
    const file = path.join(root, ".apilot", ".local", "bridge.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: (server.address() as { port: number }).port, token, pid: process.pid }), { mode: 0o600 });
  }

  /** Run a tool (from the AI via the bridge, or the panel) and keep the GUI in sync. */
  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name.startsWith("run_") && !args.env) {
      const projectId = args.project as string | undefined;
      const project = projectId ? this.hub.project(projectId) : this.hub.defaultProject();
      const env = this.envFor(project.id);
      if (env) args = { ...args, env };
    }
    const result = await callTool(this.hub, name, args);
    if (name === "run_endpoint") {
      const r = result as { endpointId: string; diffAgainstBaseline?: { breaking: boolean; summary: DiffResult["summary"] } };
      if (r.diffAgainstBaseline?.breaking) this.alertBreaking(r.endpointId, r.diffAgainstBaseline.summary.breaking);
    }
    if (name === "run_collection") {
      const r = result as { breaking: number; results: { endpointId: string; breaking: boolean; summary?: DiffResult["summary"] }[] };
      const first = r.results.find((x) => x.breaking);
      if (first) this.alertBreaking(first.endpointId, first.summary?.breaking ?? 0, r.breaking);
    }
    this.scheduleRefresh();
    return result;
  }

  private alertBreaking(endpointId: string, count: number, endpoints = 1): void {
    const msg = endpoints > 1
      ? `Apilot: ${endpoints} endpoints have breaking response changes (first: ${endpointId}).`
      : `Apilot: ${endpointId} has ${count} breaking change${count === 1 ? "" : "s"} vs its baseline.`;
    vscode.window.showWarningMessage(msg, "Show Changes", "Accept as Baseline").then((pick) => {
      if (pick === "Show Changes") this.openPanel({ endpointId, tab: "changes" });
      if (pick === "Accept as Baseline") {
        const { ws, endpointId: eid } = this.hub.resolveEndpoint(endpointId);
        ws.setBaseline(eid);
        this.scheduleRefresh();
      }
    });
  }

  private async runFromTree(item?: EndpointItem | string): Promise<void> {
    const endpointId = typeof item === "string" ? item : item?.endpointId;
    const projectId = typeof item === "string" ? undefined : item?.project.id;
    if (!endpointId) return;
    const r = (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Apilot: running ${endpointId}` },
      () => this.tool("run_endpoint", projectId ? { endpointId, project: projectId } : { endpointId })
    )) as { status: number; timeMs: number; passed: boolean; diffAgainstBaseline?: { breaking: boolean } };
    if (!r.diffAgainstBaseline?.breaking) {
      vscode.window.setStatusBarMessage(`$(${r.passed ? "pass" : "error"}) ${endpointId} → ${r.status} (${r.timeMs} ms)`, 5000);
    }
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  openPanel(focus?: Record<string, unknown>): void {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.attachPanel(
        vscode.window.createWebviewPanel("apilot.panel", "Apilot", vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview")],
        })
      );
    }
    if (focus) this.post({ type: "focus", ...focus });
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "assets", "icon.png");
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview")] };
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => (this.panel = undefined), null, this.disposables);
    panel.webview.onDidReceiveMessage(async (msg: { type: string; reqId: number; method: string; args: any }) => {
      if (msg.type !== "call") return;
      try {
        this.post({ type: "result", reqId: msg.reqId, result: await this.handle(msg.method, msg.args ?? {}) });
      } catch (err) {
        this.post({ type: "result", reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) });
      }
    }, null, this.disposables);
  }

  private post(msg: Record<string, unknown>): void {
    this.panel?.webview.postMessage(msg);
  }

  /** Requests from the panel. Tool names map 1:1 to the AI's MCP tools. */
  private async handle(method: string, a: any): Promise<unknown> {
    if (method.startsWith("tool:")) return this.tool(method.slice(5), a);
    this.requireWs(method === "state" || method === "init");
    switch (method) {
      case "state":
        return this.state();
      case "init":
        return this.init(a.project);
      case "setEnv":
        await this.setEnv(a.project ?? this.activeProject().id, a.env);
        this.tree.refresh();
        return null;
      case "endpoint": {
        const { project, ws: workspace, endpointId } = this.hub.resolveEndpoint(a.id, a.project);
        const { entry, definition } = workspace.endpoint(endpointId);
        return {
          id: endpointId,
          project: project.id,
          file: entry.file,
          collectionId: entry.collectionId,
          definition,
          snapshots: workspace.snapshots(endpointId),
          revisions: workspace.revisions(endpointId),
          latest: workspace.store.latest(endpointId) ?? null,
        };
      }
      case "save": {
        const { project: _ignored, ...rest } = a;
        const r = rest.id
          ? (() => {
              const { ws: workspace, endpointId } = this.hub.resolveEndpoint(rest.id, a.project);
              return workspace.saveEndpoint({ ...rest, id: endpointId });
            })()
          : this.hub.ensureProject(a.project).saveEndpoint(rest);
        this.scheduleRefresh();
        return r;
      }
      case "run": {
        const { project, ws: workspace, endpointId } = this.hub.resolveEndpoint(a.id, a.project);
        const r: RunOutcome = await workspace.run(endpointId, a.env ?? this.envFor(project.id));
        if (r.diff?.breaking) this.alertBreaking(endpointId, r.diff.summary.breaking);
        this.scheduleRefresh();
        return r;
      }
      case "snapshotPair": {
        const { project, ws: workspace, endpointId } = this.hub.resolveEndpoint(a.id, a.project);
        const diff = workspace.diff(endpointId, a.from, a.to);
        return {
          diff,
          from: workspace.snapshot(endpointId, diff.fromId),
          to: workspace.snapshot(endpointId, diff.toId),
          impact: workspace.impact(endpointId, diff),
          project: project.id,
        };
      }
      case "snapshot": {
        const { ws: workspace, endpointId } = this.hub.resolveEndpoint(a.id, a.project);
        return workspace.snapshot(endpointId, a.snapshotId);
      }
      case "schema": {
        const { ws: workspace, endpointId } = this.hub.resolveEndpoint(a.id, a.project);
        return workspace.schema(endpointId);
      }
      case "variables": {
        const project = a.project ? this.hub.project(a.project) : this.activeProject();
        const env = a.env ?? this.envFor(project.id);
        const name = env ?? this.hub.workspace(project.id).envName();
        return { env: name, project: project.id, variables: await this.hub.workspace(project.id).variables(name) };
      }
      case "setSecret": {
        const project = a.project ? this.hub.project(a.project) : this.activeProject();
        const env = a.env ?? this.envFor(project.id) ?? this.hub.workspace(project.id).envName();
        await this.hub.workspace(project.id).setVariable(env, a.name, "secret", a.value);
        return null;
      }
      case "openFile":
        return this.openFile(a.file, a.line, a.project);
      case "nativeDiff":
        return this.nativeDiff(a);
      case "setupAi":
        return this.setupAi(true);
      case "confirm":
        return (await vscode.window.showWarningMessage(String(a.message), { modal: true, detail: a.detail ? String(a.detail) : undefined }, String(a.action ?? "OK"))) !== undefined;
      default:
        throw new Error(`Unknown request "${method}"`);
    }
  }

  private state() {
    this.rediscover();
    const projects = this.hub.projects.map((p) => ({
      id: p.id,
      name: p.name,
      root: p.root,
      relPath: p.relPath,
      hasApilot: p.hasApilot,
    }));
    if (!this.hasProject) return { hasProject: false, hasFolder: this.folders.length > 0, projects };

    const active = this.activeProject();
    const reg = this.hub.workspace(active.id).registry();
    const endpoints = this.hub.listEndpoints().map(({ project, endpoint }) => ({
      ...endpoint,
      project: project.id,
      health: this.health(project.id, endpoint.id),
    }));
    const projectEnvs: Record<string, { env?: string; environments: string[] }> = {};
    for (const p of this.hub.projects) {
      if (!p.hasApilot) continue;
      const names = this.hub.workspace(p.id).registry().environments.map((e) => e.name);
      projectEnvs[p.id] = { env: this.envFor(p.id), environments: names };
    }
    return {
      hasProject: true,
      hasFolder: true,
      projects,
      activeProject: active.id,
      project: reg.project,
      env: this.envFor(active.id),
      environments: reg.environments.map((e) => e.name),
      projectEnvs,
      collections: reg.collections,
      endpoints,
    };
  }

  /** Status dot for an endpoint: last run result and whether it drifted from the baseline. */
  health(projectId: string, id: string): Health {
    try {
      const ws = this.hub.workspace(projectId);
      const latest = ws.store.list(id)[0];
      if (!latest) return { state: "none" };
      if (!latest.passed) return { status: latest.status, state: "failed" };
      if (latest.baseline) return { status: latest.status, state: "passed" };
      const diff = ws.diff(id);
      return { status: latest.status, state: diff.breaking ? "breaking" : diff.changes.length ? "changed" : "passed" };
    } catch {
      return { state: "none" };
    }
  }

  /**
   * What the sidebar shows at the top level. With one project that is its
   * collections; with several it is one row per project.
   */
  topLevel(): TreeRow[] {
    const projects = this.hub.projects;
    if (!projects.length) return [];
    if (projects.length === 1) {
      return this.childrenOf(projects[0]!).map((item) =>
        item instanceof CollectionItem
          ? { kind: "collection", label: String(item.label), id: item.collectionId, project: projects[0]!.id }
          : { kind: "endpoint", label: String(item.label), id: (item as EndpointItem).endpointId, project: projects[0]!.id }
      );
    }
    return projects.map((p) => ({ kind: "project", label: p.name, id: p.id }));
  }

  /** Collections and endpoints of one project, for the sidebar tree. */
  childrenOf(project: ProjectEntry, parent?: CollectionItem): vscode.TreeItem[] {
    if (!project.hasApilot) return [];
    const reg = this.hub.workspace(project.id).registry();
    const parentId = parent?.collectionId ?? "";
    const collections = reg.collections
      .filter((c) =>
        parentId
          ? c.id.startsWith(`${parentId}/`) && !c.id.slice(parentId.length + 1).includes("/")
          : !c.id.includes("/")
      )
      .map((c) => new CollectionItem(project, c.id, c.name));
    const endpoints = reg.endpoints
      .filter((e) => e.collectionId === parentId)
      .map((e) => new EndpointItem(project, e.id, e.file, e.name, e.method, e.url, this.health(project.id, e.id)));
    return [...collections, ...endpoints];
  }

  private async openFile(file: string, line?: number, projectId?: string): Promise<void> {
    const base = projectId ? this.hub.project(projectId).root : this.hub.defaultProject().root;
    const uri = vscode.Uri.file(path.isAbsolute(file) ? file : path.join(base, file));
    const doc = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      doc.selection = new vscode.Selection(pos, pos);
      doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Open two snapshots or two revisions in the editor's built-in diff view. */
  private async nativeDiff(a: { kind: "snapshot" | "revision"; id: string; from: string | number; to: string | number; project?: string }): Promise<void> {
    const { ws } = this.hub.resolveEndpoint(a.id, a.project);
    const file = (x: string | number) =>
      a.kind === "snapshot"
        ? ws.store.path(a.id, String(x))
        : path.join(ws.apilotDir, "history", ...a.id.split("/"), `${x}.yaml`);
    const left = file(a.from);
    const right = file(a.to);
    if (!left || !right || !fs.existsSync(left) || !fs.existsSync(right)) throw new Error("Files not found for that comparison.");
    const label = a.kind === "snapshot" ? `${a.id}: response ${String(a.from).slice(0, 8)} ↔ ${String(a.to).slice(0, 8)}` : `${a.id}: v${a.from} ↔ v${a.to}`;
    await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(left), vscode.Uri.file(right), label, { preview: true });
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, "index.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, "style.css"));
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="${style}">
<title>Apilot</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  private onSave(doc: vscode.TextDocument): void {
    for (const p of this.hub.projects) {
      if (!p.hasApilot) continue;
      const rel = path.relative(p.root, doc.uri.fsPath).split(path.sep).join("/");
      if (!rel.startsWith(".apilot/collections/") || !rel.endsWith(".yaml") || rel.endsWith("_folder.yaml")) continue;
      const ws = this.hub.workspace(p.id);
      const ep = ws.registry().endpoints.find((e) => e.file === rel);
      if (!ep) continue;
      try {
        ws.recordRevision(ep.id);
      } catch (err) {
        vscode.window.showErrorMessage(`Apilot: ${rel} is not a valid endpoint — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 150);
  }

  refresh(): void {
    this.rediscover();
    vscode.commands.executeCommand("setContext", "apilot.hasProject", this.hasProject);
    this.tree.refresh();
    this.post({ type: "changed" });
  }

  requireWs(allowNoProject = false): Workspace {
    if (!this.folders.length) throw new Error("Open a folder to use Apilot.");
    if (!allowNoProject && !this.hasProject) throw new Error("No Apilot project in this folder yet. Run “Apilot: Initialize Project”.");
    return this.hub.defaultWorkspace();
  }

  dispose(): void {
    this.bridge?.close();
    const bridgeFile = this.bridgeRoot && path.join(this.bridgeRoot, ".apilot", ".local", "bridge.json");
    try {
      if (bridgeFile && JSON.parse(fs.readFileSync(bridgeFile, "utf8")).pid === process.pid) fs.rmSync(bridgeFile);
    } catch {}
    this.mcpRegistration?.dispose();
    for (const w of this.watchers) w.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function ensureLocalIgnored(root: string): void {
  const file = path.join(root, ".apilot", ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (!/^\.local\/?$/m.test(current)) fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# local-only Apilot state (never commit)\n.local/\n`);
}

// ---------------------------------------------------------------------------
// Sidebar tree: projects → collections → endpoints, with status icons
// ---------------------------------------------------------------------------

class ProjectItem extends vscode.TreeItem {
  constructor(readonly project: ProjectEntry) {
    super(
      project.name,
      project.hasApilot ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = "project";
    this.iconPath = new vscode.ThemeIcon(project.hasApilot ? "folder-library" : "folder");
    this.description = project.hasApilot ? project.relPath : "not initialized";
    this.tooltip = new vscode.MarkdownString(
      `${project.hasApilot ? "**Apilot project**" : "No Apilot project in this folder yet"}\n\n\`${project.root}\``
    );
    if (!project.hasApilot) {
      this.command = { command: "apilot.init", title: "Initialize Apilot Project", arguments: [project.id] };
    }
  }
}

class CollectionItem extends vscode.TreeItem {
  constructor(readonly project: ProjectEntry, readonly collectionId: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "collection";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class EndpointItem extends vscode.TreeItem {
  constructor(
    readonly project: ProjectEntry,
    readonly endpointId: string,
    readonly file: string,
    name: string,
    method: string,
    url: string,
    health: Health
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = `${method}${health.status ? ` · ${health.status}` : ""}`;
    this.tooltip = new vscode.MarkdownString(`**${method}** \`${url}\`\n\n${project.id} · ${endpointId}${health.state === "breaking" ? "\n\n⚠ Breaking changes vs baseline" : ""}`);
    this.contextValue = "endpoint";
    const icons = { none: ["circle-outline", undefined], passed: ["pass", "testing.iconPassed"], failed: ["error", "testing.iconFailed"], breaking: ["warning", "list.warningForeground"], changed: ["diff", "charts.blue"] } as const;
    const [icon, color] = icons[health.state];
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    this.command = { command: "apilot.open", title: "Open", arguments: [this] };
  }
}

class EndpointTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly ext: ApilotExtension) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    // Expanding or focusing the view re-scans, so a project added by hand
    // shows up even if the file watcher missed it.
    if (!parent) this.ext.rediscover();
    const projects = this.ext.hub.projects;
    if (!projects.length) return []; // welcome view shows Init / Import buttons
    // One project: show its collections directly, as before.
    if (projects.length === 1) {
      return this.ext.childrenOf(projects[0]!, parent instanceof CollectionItem ? parent : undefined);
    }
    if (!parent) return projects.map((p) => new ProjectItem(p));
    if (parent instanceof ProjectItem) return this.ext.childrenOf(parent.project, undefined);
    if (parent instanceof CollectionItem) return this.ext.childrenOf(parent.project, parent);
    return [];
  }
}
