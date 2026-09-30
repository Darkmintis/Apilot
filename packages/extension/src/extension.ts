/**
 * Apilot — VS Code / Cursor extension.
 *
 * GUI-first: the Apilot panel is the main surface. Everything it does goes
 * through the same Workspace + tool table the AI uses, so the AI can do
 * whatever the user can (except see or enter secret values).
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
import { Workspace, type DiffResult, type RunOutcome, type SecretProvider } from "@apilot/core";
import { callTool } from "@apilot/mcp/tools";
import { aiFiles, writeAiFiles, MARKER } from "@apilot/skill";

let ext: ApilotExtension | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  ext = new ApilotExtension(ctx);
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

class ApilotExtension implements vscode.Disposable {
  readonly root: string | undefined;
  readonly ws: Workspace | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private bridge: http.Server | undefined;
  private mcpRegistration: vscode.Disposable | undefined;
  private readonly tree = new EndpointTree(this);
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.ws = this.root ? new Workspace(this.root, { secrets: new KeychainSecrets(ctx.secrets, this.root), timeout: this.config<number>("timeout") }) : undefined;

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
      cmd("apilot.open", (id?: string) => this.openPanel(typeof id === "string" ? { endpointId: id } : undefined)),
      cmd("apilot.init", () => this.init()),
      cmd("apilot.newEndpoint", () => this.openPanel({ view: "new" })),
      cmd("apilot.import", () => this.openPanel({ view: "import" })),
      cmd("apilot.environments", () => this.openPanel({ view: "environments" })),
      cmd("apilot.runAll", () => this.openPanel({ view: "runAll", autorun: true })),
      cmd("apilot.runEndpoint", (item?: EndpointItem | string) => this.runFromTree(typeof item === "string" ? item : item?.endpointId)),
      cmd("apilot.openFile", (item?: EndpointItem) => item?.file && this.openFile(item.file)),
      cmd("apilot.refresh", () => this.refresh()),
      cmd("apilot.setupAi", () => this.setupAi(true)),
      cmd("apilot.removeAi", () => this.removeAi()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.window.registerWebviewPanelSerializer("apilot.panel", {
        deserializeWebviewPanel: async (panel) => this.attachPanel(panel),
      })
    );

    if (this.root) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, ".apilot/**"));
      const onChange = (uri: vscode.Uri) => {
        if (!uri.fsPath.includes(`${path.sep}.local${path.sep}`)) this.scheduleRefresh();
      };
      this.disposables.push(watcher, watcher.onDidCreate(onChange), watcher.onDidChange(onChange), watcher.onDidDelete(onChange));
    }

    this.onProjectReady();
  }

  config<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration("apilot").get<T>(key);
  }

  get hasProject(): boolean {
    return !!this.ws?.exists();
  }

  get env(): string | undefined {
    return this.ctx.workspaceState.get<string>("apilot.env");
  }

  /** Called on activation and after `init`: everything that needs a project. */
  private onProjectReady(): void {
    vscode.commands.executeCommand("setContext", "apilot.hasProject", this.hasProject);
    if (!this.hasProject || !this.root) return;
    ensureLocalIgnored(this.root);
    this.startBridge().catch((err) => console.error("[apilot] bridge failed", err));
    if (this.config<boolean>("ai.autoSetup") !== false && !this.ctx.workspaceState.get("apilot.aiRemoved")) this.setupAi(false);
  }

  private async init(): Promise<void> {
    if (!this.ws) throw new Error("Open a folder first.");
    const name = await vscode.window.showInputBox({ title: "Apilot — new project", prompt: "Project name", value: path.basename(this.root!) });
    if (name === undefined) return;
    this.ws.init(name || "my-api");
    this.onProjectReady();
    this.refresh();
    this.openPanel();
  }

  // -------------------------------------------------------------------------
  // AI setup: skills + MCP registration (no manual "connect")
  // -------------------------------------------------------------------------

  private setupAi(manual: boolean): void {
    if (!this.root) return;
    const written = writeAiFiles(this.root);
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
    if (!this.root) return;
    for (const f of aiFiles()) {
      const full = path.join(this.root, f.path);
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
    if (this.mcpRegistration || !this.root) return this.mcpRegistration ? (vscode.env.appName.includes("Cursor") ? "Cursor" : "VS Code") : "none";
    const server = {
      command: process.execPath,
      args: [this.ctx.asAbsolutePath(path.join("dist", "mcp.mjs"))],
      env: { ELECTRON_RUN_AS_NODE: "1", APILOT_PROJECT_ROOT: this.root },
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
    if (this.bridge || !this.root) return;
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
    const file = path.join(this.root, ".apilot", ".local", "bridge.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: (server.address() as { port: number }).port, token, pid: process.pid }), { mode: 0o600 });
  }

  /** Run a tool (from the AI via the bridge, or the panel) and keep the GUI in sync. */
  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const ws = this.requireWs();
    if (name.startsWith("run_") && !args.env && this.env) args = { ...args, env: this.env };
    const result = await callTool(ws, name, args);
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
        this.requireWs().setBaseline(endpointId);
        this.scheduleRefresh();
      }
    });
  }

  private async runFromTree(endpointId?: string): Promise<void> {
    if (!endpointId) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Apilot: running ${endpointId}` }, () =>
      this.tool("run_endpoint", { endpointId })
    ) as { status: number; timeMs: number; passed: boolean; diffAgainstBaseline?: { breaking: boolean } };
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
    const ws = this.requireWs(method === "state" || method === "init");
    switch (method) {
      case "state":
        return this.state();
      case "init":
        return this.init();
      case "setEnv":
        await this.ctx.workspaceState.update("apilot.env", a.env);
        this.tree.refresh();
        return null;
      case "endpoint": {
        const { entry, definition } = ws.endpoint(a.id);
        const snapshots = ws.snapshots(a.id);
        return { id: a.id, file: entry.file, collectionId: entry.collectionId, definition, snapshots, revisions: ws.revisions(a.id), latest: ws.store.latest(a.id) ?? null };
      }
      case "save": {
        const r = ws.saveEndpoint(a);
        this.scheduleRefresh();
        return r;
      }
      case "run": {
        const r: RunOutcome = await ws.run(a.id, a.env ?? this.env);
        if (r.diff?.breaking) this.alertBreaking(a.id, r.diff.summary.breaking);
        this.scheduleRefresh();
        return r;
      }
      case "snapshotPair": {
        const diff = ws.diff(a.id, a.from, a.to);
        return { diff, from: ws.snapshot(a.id, diff.fromId), to: ws.snapshot(a.id, diff.toId), impact: ws.impact(a.id, diff) };
      }
      case "snapshot":
        return ws.snapshot(a.id, a.snapshotId);
      case "schema":
        return ws.schema(a.id);
      case "variables": {
        const env = ws.envName(a.env ?? this.env);
        return { env, variables: await ws.variables(env) };
      }
      case "setSecret":
        await ws.setVariable(ws.envName(a.env), a.name, "secret", a.value);
        return null;
      case "openFile":
        return this.openFile(a.file, a.line);
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
    const ws = this.ws;
    if (!ws || !this.hasProject) return { hasProject: false, hasFolder: !!ws };
    const reg = ws.registry();
    const env = this.env && reg.environments.some((e) => e.name === this.env) ? this.env : reg.project.defaultEnvironment ?? reg.environments[0]?.name;
    return {
      hasProject: true,
      hasFolder: true,
      project: reg.project,
      env,
      environments: reg.environments.map((e) => e.name),
      collections: reg.collections,
      endpoints: reg.endpoints.map((e) => ({ ...e, health: this.health(e.id) })),
    };
  }

  /** Status dot for an endpoint: last run result and whether it drifted from the baseline. */
  health(id: string): { status?: number; state: "none" | "passed" | "failed" | "breaking" | "changed" } {
    const ws = this.requireWs();
    try {
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

  private async openFile(file: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(path.isAbsolute(file) ? file : path.join(this.root!, file));
    const doc = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      doc.selection = new vscode.Selection(pos, pos);
      doc.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  /** Open two snapshots or two revisions in the editor's built-in diff view. */
  private async nativeDiff(a: { kind: "snapshot" | "revision"; id: string; from: string | number; to: string | number }): Promise<void> {
    const ws = this.requireWs();
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
    if (!this.ws || !this.root) return;
    const rel = path.relative(this.root, doc.uri.fsPath).split(path.sep).join("/");
    if (!rel.startsWith(".apilot/collections/") || !rel.endsWith(".yaml") || rel.endsWith("_folder.yaml")) return;
    const ep = this.ws.registry().endpoints.find((e) => e.file === rel);
    if (!ep) return;
    try {
      this.ws.recordRevision(ep.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Apilot: ${rel} is not a valid endpoint — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 150);
  }

  refresh(): void {
    vscode.commands.executeCommand("setContext", "apilot.hasProject", this.hasProject);
    this.tree.refresh();
    this.post({ type: "changed" });
  }

  requireWs(allowNoProject = false): Workspace {
    if (!this.ws) throw new Error("Open a folder to use Apilot.");
    if (!allowNoProject && !this.hasProject) throw new Error("No Apilot project in this folder yet. Run “Apilot: Initialize Project”.");
    return this.ws;
  }

  dispose(): void {
    this.bridge?.close();
    const bridgeFile = this.root && path.join(this.root, ".apilot", ".local", "bridge.json");
    try {
      if (bridgeFile && JSON.parse(fs.readFileSync(bridgeFile, "utf8")).pid === process.pid) fs.rmSync(bridgeFile);
    } catch {}
    this.mcpRegistration?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function ensureLocalIgnored(root: string): void {
  const file = path.join(root, ".apilot", ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (!/^\.local\/?$/m.test(current)) fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# local-only Apilot state (never commit)\n.local/\n`);
}

// ---------------------------------------------------------------------------
// Sidebar tree: collections → endpoints, with status icons
// ---------------------------------------------------------------------------

class CollectionItem extends vscode.TreeItem {
  constructor(readonly collectionId: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "collection";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

class EndpointItem extends vscode.TreeItem {
  constructor(readonly endpointId: string, readonly file: string, name: string, method: string, url: string, health: ReturnType<ApilotExtension["health"]>) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = `${method}${health.status ? ` · ${health.status}` : ""}`;
    this.tooltip = new vscode.MarkdownString(`**${method}** \`${url}\`\n\n${endpointId}${health.state === "breaking" ? "\n\n⚠ Breaking changes vs baseline" : ""}`);
    this.contextValue = "endpoint";
    const icons = { none: ["circle-outline", undefined], passed: ["pass", "testing.iconPassed"], failed: ["error", "testing.iconFailed"], breaking: ["warning", "list.warningForeground"], changed: ["diff", "charts.blue"] } as const;
    const [icon, color] = icons[health.state];
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    this.command = { command: "apilot.open", title: "Open", arguments: [endpointId] };
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
    if (!this.ext.hasProject) return []; // welcome view shows Init / Import buttons
    const reg = this.ext.requireWs().registry();
    const parentId = parent instanceof CollectionItem ? parent.collectionId : "";
    const collections = reg.collections
      .filter((c) => (parentId ? c.id.startsWith(`${parentId}/`) && !c.id.slice(parentId.length + 1).includes("/") : !c.id.includes("/")))
      .map((c) => new CollectionItem(c.id, c.name));
    const endpoints = reg.endpoints
      .filter((e) => e.collectionId === parentId)
      .map((e) => new EndpointItem(e.id, e.file, e.name, e.method, e.url, this.ext.health(e.id)));
    return [...collections, ...endpoints];
  }
}
