/**
 * Apilot — VS Code/Cursor extension entry point.
 *
 * Wires the editor to @apilot/core:
 *  - SecretStorage for secrets (OS keychain)
 *  - FileResolver backed by the VS Code filesystem
 *  - Webview panel for the interactive UI
 *  - Tree view for collections/endpoints
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { FileResolver } from "@apilot/core";
import {
  Registry,
  resolveContext,
  RequestRunner,
  JsonSnapshotStore,
  Differ,
  inferSchema,
  parseEndpointFile,
  parseEnvironmentFile,
  type RunContext,
  type EnvironmentFile,
  type ProjectRegistry,
} from "@apilot/core";
import { CodegenEngine } from "@apilot/codegen";

// ---------------------------------------------------------------------------
// VS Code-backed FileResolver
// ---------------------------------------------------------------------------

class VsCodeFileResolver implements FileResolver {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  read(relPath: string): string | undefined {
    const full = path.join(this.root, relPath);
    try {
      return fs.readFileSync(full, "utf-8");
    } catch {
      return undefined;
    }
  }

  exists(relPath: string): boolean {
    return fs.existsSync(path.join(this.root, relPath));
  }

  listDir(relPath: string): string[] {
    try {
      return fs.readdirSync(path.join(this.root, relPath));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Secret management
// ---------------------------------------------------------------------------

const SECRET_KEY_PREFIX = "apilot:";

export class VsCodeSecretStore {
  /**
   * Ensure all secret variables in an environment have values in the
   * OS keyring. If some are missing, prompt the user.
   * Returns the resolved EnvironmentFile with secrets filled in (as SecretRef).
   */
  static async ensureSecrets(
    env: EnvironmentFile,
    secrets: vscode.SecretStorage
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const [name, def] of Object.entries(env.variables)) {
      if (def.type === "secret") {
        const key = `${SECRET_KEY_PREFIX}${name}`;
        const value = await secrets.get(key);
        if (!value) {
          missing.push(name);
        }
      }
    }
    return missing;
  }

  /**
   * Prompt the user to enter values for missing secrets.
   */
  static async promptSecrets(
    missing: string[],
    secrets: vscode.SecretStorage
  ): Promise<void> {
    for (const name of missing) {
      const value = await vscode.window.showInputBox({
        prompt: `Enter value for secret: ${name}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        await secrets.store(`${SECRET_KEY_PREFIX}${name}`, value);
      }
    }
  }

  /**
   * Build a SecretResolver that reads from VS Code SecretStorage.
   */
  static makeResolver(
    env: EnvironmentFile,
    secrets: vscode.SecretStorage
  ): { resolveContext: () => Promise<RunContext>; secretValues: Record<string, string> } {
    return {
      resolveContext: async () => {
        const secretValues: Record<string, string> = {};
        for (const [name, def] of Object.entries(env.variables)) {
          if (def.type === "secret") {
            const key = `${SECRET_KEY_PREFIX}${name}`;
            const value = await secrets.get(key);
            if (value) {
              secretValues[name] = value;
            }
          }
        }
        // Build a SecretResolver that reads from the already-fetched values
        const context = await resolveContext(env, {
          resolve: async (secretName: string) => {
            return (
              secretValues[secretName] ??
              (await secrets.get(`${SECRET_KEY_PREFIX}${secretName}`)) ??
              ""
            );
          },
        });
        // Attach secret values for redaction (in-memory only)
        (context as any)._secretValues = secretValues;
        return context;
      },
      secretValues: {}, // populated lazily
    };
  }
}

// ---------------------------------------------------------------------------
// Snapshot store backed by VS Code filesystem
// ---------------------------------------------------------------------------

class VsCodeSnapshotStore extends JsonSnapshotStore {
  constructor(root: string) {
    super({
      root,
      retention: 20,
      writeFile: async (relPath, content) => {
        const full = path.join(root, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf-8");
      },
      readFile: async (relPath) => {
        try {
          return fs.readFileSync(path.join(root, relPath), "utf-8");
        } catch {
          return undefined;
        }
      },
      listDir: async (relPath) => {
        try {
          return fs.readdirSync(path.join(root, relPath));
        } catch {
          return [];
        }
      },
      deleteFile: async (relPath) => {
        try {
          fs.unlinkSync(path.join(root, relPath));
        } catch {
          /* ignore */
        }
      },
      ensureDir: async (relPath) => {
        fs.mkdirSync(path.join(root, relPath), { recursive: true });
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Main extension activation
// ---------------------------------------------------------------------------

export class ApilotExtension {
  private readonly ctx: vscode.ExtensionContext;
  private readonly workspaceRoot: string;
  private readonly fileResolver: VsCodeFileResolver;
  private readonly runner: RequestRunner;
  private readonly differ: Differ;
  private _registry: ProjectRegistry | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    this.fileResolver = new VsCodeFileResolver(this.workspaceRoot);
    this.runner = new RequestRunner();
    this.differ = new Differ();

    // Initialize .apilot structure if missing
    this._ensureApilotFolder();
  }

  /** Set up all VS Code integrations. */
  activate(): void {
    // Tree view for collections
    const treeProvider = new CollectionsTreeProvider(this);
    vscode.window.registerTreeDataProvider(
      "apilot.collections",
      treeProvider
    );

    // Commands
    this.ctx.subscriptions.push(
      vscode.commands.registerCommand(
        "apilot.openDashboard",
        () => this.openDashboard()
      ),
      vscode.commands.registerCommand(
        "apilot.runEndpoint",
        () => this.runSelectedEndpoint()
      ),
      vscode.commands.registerCommand(
        "apilot.runAll",
        () => this.runAllEndpoints()
      ),
      vscode.commands.registerCommand(
        "apilot.diffEndpoint",
        () => this.diffSelectedEndpoint()
      ),
      vscode.commands.registerCommand(
        "apilot.generateCode",
        () => this.generateCode()
      ),
      vscode.commands.registerCommand(
        "apilot.connectAI",
        () => this.connectAI()
      ),
      vscode.commands.registerCommand(
        "apilot.promptSecrets",
        () => this.promptMissingSecrets()
      )
    );

    // Auto-detect .apilot and refresh tree
    if (this.hasApilotProject()) {
      vscode.commands.executeCommand(
        "setContext",
        "apilot.active",
        true
      );
    }
  }

  /** Check if the current workspace has an .apilot folder. */
  hasApilotProject(): boolean {
    return this.fileResolver.exists(".apilot/apilot.yaml");
  }

  get registry(): ProjectRegistry {
    if (!this._registry) {
      const registry = new Registry(this.fileResolver);
      this._registry = registry.build();
    }
    return this._registry;
  }

  /** Refresh the in-memory registry (call after file changes). */
  refresh(): void {
    this._registry = undefined;
  }

  // -----------------------------------------------------------------------
  // Webview dashboard
  // -----------------------------------------------------------------------

  /** Open the full Apilot dashboard in a webview panel. */
  private async openDashboard(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "apilot.dashboard",
      "Apilot — API Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.file(
            path.join(this.ctx.extensionPath, "..", "..", "webview", "dist")
          ),
        ],
      }
    );

    // Build initial state to send to the webview
    const registry = this._registry ?? new Registry(this.fileResolver).build();
    const environments = registry.environments;

    panel.webview.html = this._getWebviewHtml(panel);

    // Send initial data
    this._postMessage(panel, "init", {
      registry,
      environments: environments,
      workspaceRoot: this.workspaceRoot,
      hasApilotProject: this.hasApilotProject(),
    });

    // Listen for messages from the webview
    panel.webview.onDidReceiveMessage(async (message) => {
      await this._handleWebviewMessage(panel, message);
    });

    // Auto-dispose when panel closes
    panel.onDidDispose(
      () => {
        // cleanup if needed
      },
      null,
      this.ctx.subscriptions
    );
  }

  /** Run an endpoint from the webview. */
  private async runEndpointFromWebview(
    endpointId: string,
    envName: string
  ): Promise<void> {
    try {
      const ep = this.registry.endpoints.find((e) => e.id === endpointId);
      if (!ep) {
        throw new Error(`Endpoint "${endpointId}" not found`);
      }

      // Load environment + resolve secrets
      const envRaw = this.fileResolver.read(`.apilot/environments/${envName}.yaml`);
      if (!envRaw) {
        throw new Error(`Environment "${envName}" not found`);
      }
      const env = parseEnvironmentFile(envRaw, `${envName}.yaml`);

      const missing = await VsCodeSecretStore.ensureSecrets(
        env,
        this.ctx.secrets
      );
      if (missing.length > 0) {
        await VsCodeSecretStore.promptSecrets(missing, this.ctx.secrets);
      }

      const resolver = VsCodeSecretStore.makeResolver(
        env,
        this.ctx.secrets
      );
      const ctx = await resolver.resolveContext();

      // Load endpoint file, parse, resolve, run
      const epRaw = this.fileResolver.read(ep.file);
      if (!epRaw) {
        throw new Error(`Cannot read endpoint file: ${ep.file}`);
      }
      const endpoint = parseEndpointFile(epRaw, ep.file);

      const request = this.runner.resolve(endpoint, ctx);
      const snapshot = await this.runner.run(request, ctx, endpointId);

      // Save snapshot (redacted)
      const store = new VsCodeSnapshotStore(
        path.join(this.workspaceRoot, ".apilot")
      );
      const secretValues = (ctx as any)._secretValues ?? {};
      await store.save(snapshot, { secretValues });

      vscode.window.showInformationMessage(
        `Ran ${endpoint.name} — ${responseStatus(snapshot.status)}`
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to run endpoint: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Run an endpoint and return the result for the webview. */
  private async _webviewRunEndpoint(endpointId: string, envName?: string): Promise<any> {
    try {
      const ep = this.registry.endpoints.find((e) => e.id === endpointId);
      if (!ep) throw new Error(`Endpoint "${endpointId}" not found`);

      const env = await this._loadEnv(envName);
      const ctx = await this._resolveContext(env);

      const epRaw = this.fileResolver.read(ep.file);
      if (!epRaw) throw new Error(`Cannot read endpoint file: ${ep.file}`);
      const endpoint = parseEndpointFile(epRaw, ep.file);

      const request = this.runner.resolve(endpoint, ctx);
      const snapshot = await this.runner.run(request, ctx, endpointId);

      const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
      const secretValues = (ctx as any)._secretValues ?? {};
      await store.save(snapshot, { secretValues });

      return {
        endpointId,
        name: ep.name,
        method: ep.method,
        url: request.url,
        status: snapshot.status,
        passed: snapshot.passed,
        durationMs: snapshot.timeMs,
        headers: snapshot.headers,
        body: snapshot.body,
      };
    } catch (err) {
      return {
        endpointId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Run all endpoints and return summary. */
  private async _webviewRunAll(): Promise<any> {
    const results = await Promise.all(
      this.registry.endpoints.map((ep) =>
        this._webviewRunEndpoint(ep.id, undefined)
      )
    );
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => r.error).length;
    return {
      total: results.length,
      passed,
      failed,
      results,
    };
  }

  /** Get diff result for the webview. */
  private async _webviewDiff(endpointId: string): Promise<any> {
    const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
    const snaps = await store.list(endpointId);
    if (snaps.length < 2) {
      return { error: "Need at least 2 snapshots to diff. Run the endpoint twice." };
    }

    const from = await store.load(snaps[snaps.length - 1]!.id);
    const to = await store.load(snaps[0]!.id);
    if (!from || !to) return { error: "Failed to load snapshots" };

    const diff = this.differ.diff({ endpointId, from, to });
    return {
      endpointId,
      summary: diff.summary,
      changes: diff.changes,
    };
  }

  /** Generate code and write to disk. */
  private async _webviewGenerateCode(endpointId: string, language: string): Promise<any> {
    try {
      const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
      const snap = await store.latest(endpointId);
      if (!snap) throw new Error("No snapshot available. Run the endpoint first.");

      const schema = inferSchema(snap.body);
      const ep = this.registry.endpoints.find((e) => e.id === endpointId);
      if (!ep) throw new Error(`Endpoint ${endpointId} not found`);

      const engine = new CodegenEngine();
      const files = engine.generate({
        endpointId,
        endpointName: ep.name,
        method: ep.method,
        url: ep.url,
        schema,
        language: language ?? "dart",
        outputPath: `.apilot/generated/${endpointId.replace(/\./g, "/")}`,
      });

      // Write all files to disk
      for (const file of files) {
        const fullPath = path.join(this.workspaceRoot, file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, "utf-8");
      }

      return {
        endpointId,
        language,
        fileCount: files.length,
        files: files.map((f) => ({ path: f.path, language: f.language })),
      };
    } catch (err) {
      return { endpointId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Load environment file, checking secrets. */
  private async _loadEnv(envName?: string): Promise<EnvironmentFile> {
    const registry = this.registry;
    const name = envName ??
      registry.project.defaultEnvironment ??
      registry.environments[0]?.name ??
      "dev";

    const raw = this.fileResolver.read(`.apilot/environments/${name}.yaml`);
    if (!raw) throw new Error(`Environment "${name}" not found`);

    const env = parseEnvironmentFile(raw, `${name}.yaml`);
    const missing = await VsCodeSecretStore.ensureSecrets(env, this.ctx.secrets);
    if (missing.length > 0) {
      vscode.window.showWarningMessage(
        `Missing secrets for "${name}": ${missing.join(", ")}. Run "Apilot: Enter Missing Secrets".`
      );
      await VsCodeSecretStore.promptSecrets(missing, this.ctx.secrets);
    }
    return env;
  }

  /** Resolve environment variables + secrets into a RunContext. */
  private async _resolveContext(env: EnvironmentFile): Promise<RunContext> {
    const resolver = VsCodeSecretStore.makeResolver(env, this.ctx.secrets);
    return resolver.resolveContext();
  }

  // -----------------------------------------------------------------------
  // Command handlers
  // -----------------------------------------------------------------------

  private async runSelectedEndpoint(): Promise<void> {
    const ep = await vscode.window.showQuickPick(
      this.registry.endpoints.map((e) => ({
        label: e.name,
        detail: `${e.method} ${e.url}`,
        id: e.id,
      })),
      { placeHolder: "Select an endpoint to run" }
    );
    if (!ep) return;

    const envName = await this._pickEnvironment();
    if (!envName) return;

    await this.runEndpointFromWebview(ep.id, envName);
  }

  private async runAllEndpoints(): Promise<void> {
    // Run every endpoint and show a summary
    const results: { id: string; passed: boolean; status: number }[] = [];
    for (const ep of this.registry.endpoints) {
      try {
        const request = this.runner.resolve(
          { name: ep.name, method: ep.method, url: ep.url } as any,
          { variables: {}, secretNames: [] } as RunContext
        );
        const snapshot = await this.runner.run(
          request,
          { variables: {}, secretNames: [] } as RunContext,
          ep.id
        );
        results.push({
          id: ep.id,
          passed: snapshot.passed,
          status: snapshot.status,
        });
      } catch (err) {
        results.push({
          id: ep.id,
          passed: false,
          status: 0,
        });
      }
    }

    const passed = results.filter((r) => r.passed).length;
    vscode.window.showInformationMessage(
      `Ran ${results.length} endpoints — ${passed}/${results.length} passed`
    );
  }

  private async diffSelectedEndpoint(): Promise<void> {
    const ep = await vscode.window.showQuickPick(
      this.registry.endpoints.map((e) => ({
        label: e.name,
        detail: `${e.method} ${e.url}`,
        id: e.id,
      })),
      { placeHolder: "Select an endpoint to diff" }
    );
    if (!ep) return;

    const store = new VsCodeSnapshotStore(
      path.join(this.workspaceRoot, ".apilot")
    );
    const snapshots = await store.list(ep.id);
    if (snapshots.length < 2) {
      vscode.window.showWarningMessage(
        "Need at least 2 snapshots to diff. Run the endpoint twice."
      );
      return;
    }

    const fromSnap = await store.load(snapshots[1]!.id);
    const toSnap = await store.load(snapshots[0]!.id);
    if (!fromSnap || !toSnap) return;

    const diff = this.differ.diff({
      endpointId: ep.id,
      from: fromSnap,
      to: toSnap,
    });

    // Show diff in a webview
    const panel = vscode.window.createWebviewPanel(
      "apilot.diff",
      `Diff: ${ep.label}`,
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );
    panel.webview.html = this._getDiffHtml(diff);
  }

  private async generateCode(): Promise<void> {
    const ep = await vscode.window.showQuickPick(
      this.registry.endpoints.map((e) => ({
        label: e.name,
        detail: `${e.method} ${e.url}`,
        id: e.id,
      })),
      { placeHolder: "Select an endpoint to generate code for" }
    );
    if (!ep) return;

    const lang = await vscode.window.showQuickPick(
      [
        { label: "Dart / Flutter (freezed)", value: "dart" },
        { label: "TypeScript (zod)", value: "typescript" },
        { label: "Kotlin (data class)", value: "kotlin" },
        { label: "Swift (Codable)", value: "swift" },
      ] as const,
      { placeHolder: "Select codegen target" }
    );
    if (!lang) return;

    const store = new VsCodeSnapshotStore(
      path.join(this.workspaceRoot, ".apilot")
    );
    const snap = await store.latest(ep.id);
    if (!snap) {
      vscode.window.showWarningMessage("No snapshot available. Run the endpoint first.");
      return;
    }

    const schema = inferSchema(snap.body);
    // Use the shared CodegenEngine from @apilot/codegen
    const engine = new CodegenEngine();
    const endpoint = this.registry.endpoints.find((e) => e.id === ep.id)!;
    const codeFiles = engine.generate({
      endpointId: ep.id,
      endpointName: endpoint.name,
      method: endpoint.method,
      url: endpoint.url,
      schema,
      language: lang.value,
      outputPath: `.apilot/generated/${ep.id.replace(/\./g, "/")}`,
    });

    // Show the first generated file in the editor
    const primary = codeFiles[0]!;
    const doc = await vscode.workspace.openTextDocument({
      content: primary.content,
      language: vscodeLanguage(lang.value),
    });
    await vscode.window.showTextDocument(doc);

    // Offer to write all generated files
    const write = await vscode.window.showInformationMessage(
      `Generated ${codeFiles.length} file(s) for ${ep.id}. Write to disk?`,
      "Write All", "Cancel"
    );
    if (write === "Write All") {
      for (const file of codeFiles) {
        const fullPath = path.join(this.workspaceRoot, file.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, file.content, "utf-8");
      }
      vscode.window.showInformationMessage(`Wrote ${codeFiles.length} files.`);
    }
  }

  private async connectAI(): Promise<void> {
    const mcpPath = path.join(
      this.ctx.extensionPath,
      "..",
      "mcp",
      "dist",
      "index.js"
    );

    // Start the local IPC bridge server (the MCP server proxies to this)
    const bridgeToken = crypto
      .randomBytes(32)
      .toString("hex");
    this._bridgeToken = bridgeToken;
    const bridgePort = await this._startBridgeServer();

    // Write bridge config so the MCP server can discover it
    const bridgeConfig = {
      host: "127.0.0.1",
      port: bridgePort,
      token: bridgeToken,
    };
    fs.mkdirSync(path.join(this.workspaceRoot, ".apilot"), { recursive: true });
    fs.writeFileSync(
      path.join(this.workspaceRoot, ".apilot", ".mcp-bridge.json"),
      JSON.stringify(bridgeConfig, null, 2),
      "utf-8"
    );

    // Start a cleanup timer that removes the bridge file on deactivate
    this.ctx.subscriptions.push({
      dispose: () => {
        try { fs.unlinkSync(path.join(this.workspaceRoot, ".apilot", ".mcp-bridge.json")); } catch {}
        this._bridgeServer?.close();
      },
    } as any);

    // Write MCP config (Cursor)
    const configDir = path.join(os.homedir(), ".cursor");
    const configPath = path.join(configDir, "mcp.json");
    let config: any = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {}

    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers.apilot = {
      command: "node",
      args: [mcpPath],
      env: {
        APilot_PROJECT_ROOT: this.workspaceRoot,
      },
    };

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Also write a Claude Desktop config for VS Code users
    const claudeConfigDir = path.join(os.homedir(), ".config", "Claude");
    const claudeConfigPath = path.join(claudeConfigDir, "claude_desktop_config.json");
    let claudeConfig: any = {};
    try {
      claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
    } catch {}
    claudeConfig.mcpServers = claudeConfig.mcpServers ?? {};
    claudeConfig.mcpServers.apilot = {
      command: "node",
      args: [mcpPath],
      env: {
        APilot_PROJECT_ROOT: this.workspaceRoot,
      },
    };
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));

    vscode.window.showInformationMessage(
      "Apilot MCP server registered. Restart your AI client (Cursor/Claude/Cody) to activate."
    );
  }

  private _bridgeServer: import("node:http").Server | null = null;

  /** Start a local HTTP bridge that proxies tool calls to the extension. */
  private _startBridgeServer(): Promise<number> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const url = new URL(req.url ?? "", `http://${req.headers.host}`);
          const method = url.pathname.slice(1); // "run_endpoint", etc.

          // Verify auth token
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${this._bridgeToken ?? ""}`) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }

          try {
            const params = JSON.parse(body || "{}");
            this._handleBridgeMessage(method, params)
              .then((result) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
              })
              .catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
              });
          } catch {
            res.writeHead(400);
            res.end("Bad Request");
          }
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port;
        this._bridgeServer = server;
        resolve(port);
      });
    });
  }

  private _bridgeToken: string | null = null;

  /** Handle a message from the MCP server via the bridge. */
  private async _handleBridgeMessage(
    method: string,
    params: any
  ): Promise<any> {
    switch (method) {
      case "run_endpoint":
        return this._bridgeRunEndpoint(params);
      case "list_endpoints":
        return this._bridgeListEndpoints();
      case "get_schema":
        return this._bridgeGetSchema(params);
      case "diff_endpoint":
        return this._bridgeDiffEndpoint(params);
      case "list_variables":
        return this._bridgeListVariables(params);
      case "run_collection":
        return this._bridgeRunCollection(params);
      case "impact_report":
        return this._bridgeImpactReport(params);
      case "generate_code":
        return this._bridgeGenerateCode(params);
      default:
        return { error: `Unknown bridge method: ${method}` };
    }
  }

  private async _bridgeRunEndpoint(params: any): Promise<any> {
    const ep = this.registry.endpoints.find((e) => e.id === params.endpointId);
    if (!ep) throw new Error(`Endpoint ${params.endpointId} not found`);

    const envName =
      params.envName ??
      this._registry?.project.defaultEnvironment ??
      this._registry?.environments[0]?.name;

    const envRaw = this.fileResolver.read(`.apilot/environments/${envName}.yaml`);
    const env = envRaw
      ? parseEnvironmentFile(envRaw, `${envName}.yaml`)
      : { name: envName ?? "unknown", variables: {} };

    const missing = await VsCodeSecretStore.ensureSecrets(env, this.ctx.secrets);
    if (missing.length > 0) {
      await VsCodeSecretStore.promptSecrets(missing, this.ctx.secrets);
    }

    const resolver = VsCodeSecretStore.makeResolver(env, this.ctx.secrets);
    const ctx = await resolver.resolveContext();

    const epRaw = this.fileResolver.read(ep.file);
    if (!epRaw) throw new Error(`Cannot read: ${ep.file}`);
    const endpoint = parseEndpointFile(epRaw, ep.file);

    const request = this.runner.resolve(endpoint, ctx);
    const snapshot = await this.runner.run(request, ctx, ep.id);

    const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
    const secretValues = (ctx as any)._secretValues ?? {};
    await store.save(snapshot, { secretValues });

    return {
      endpointId: params.endpointId,
      status: snapshot.status,
      passed: snapshot.passed,
      bodyType: Array.isArray(snapshot.body) ? "array" : typeof snapshot.body,
      bodySize: JSON.stringify(snapshot.body).length,
      duration: snapshot.timeMs,
    };
  }

  private _bridgeListEndpoints(): any {
    const reg = this._registry ?? new Registry(this.fileResolver).build();
    return {
      collections: reg.collections,
      endpoints: reg.endpoints,
    };
  }

  private async _bridgeGetSchema(params: any): Promise<any> {
    const ep = this.registry.endpoints.find((e) => e.id === params.endpointId);
    if (!ep) throw new Error(`Endpoint ${params.endpointId} not found`);

    const envName = params.envName ?? this._registry?.environments[0]?.name;
    if (!envName) throw new Error("No environment specified");

    const envRaw = this.fileResolver.read(`.apilot/environments/${envName}.yaml`);
    if (!envRaw) throw new Error(`Environment ${envName} not found`);

    const env = parseEnvironmentFile(envRaw, `${envName}.yaml`);
    const missing = await VsCodeSecretStore.ensureSecrets(env, this.ctx.secrets);
    if (missing.length > 0) {
      await VsCodeSecretStore.promptSecrets(missing, this.ctx.secrets);
    }

    const resolver = VsCodeSecretStore.makeResolver(env, this.ctx.secrets);
    const ctx = await resolver.resolveContext();

    const epRaw = this.fileResolver.read(ep.file);
    if (!epRaw) throw new Error(`Cannot read: ${ep.file}`);
    const endpoint = parseEndpointFile(epRaw, ep.file);

    const request = this.runner.resolve(endpoint, ctx);
    const snapshot = await this.runner.run(request, ctx, ep.id);

    const schema = inferSchema(snapshot.body);
    return { schema, endpointId: params.endpointId, endpoint: { name: ep.name, method: ep.method, url: ep.url } };
  }

  private async _bridgeDiffEndpoint(params: any): Promise<any> {
    const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
    const snaps = await store.list(params.endpointId);
    if (snaps.length < 2) throw new Error("Need at least 2 snapshots to diff.");

    const from = await store.load(snaps[1]!.id);
    const to = await store.load(snaps[0]!.id);
    if (!from || !to) throw new Error("Failed to load snapshots");

    const diff = this.differ.diff({ endpointId: params.endpointId, from, to });
    return {
      endpointId: params.endpointId,
      summary: diff.summary,
      changes: diff.changes,
    };
  }

  private _bridgeListVariables(params: any): any {
    const reg = this._registry ?? new Registry(this.fileResolver).build();
    const envName = params.envName ?? reg.project.defaultEnvironment ?? reg.environments[0]?.name;
    if (!envName) throw new Error("No environment found");

    const raw = this.fileResolver.read(`.apilot/environments/${envName}.yaml`);
    if (!raw) throw new Error(`Environment ${envName} not found`);

    const doc = parseEnvironmentFile(raw, `${envName}.yaml`);
    const variables = Object.entries(doc.variables ?? {}).map(([name, def]) => ({
      name,
      type: def.type,
      value: def.type === "text" ? def.value : undefined,
    }));

    return { envName, variables };
  }

  private async _bridgeRunCollection(params: any): Promise<any> {
    const reg = this._registry ?? new Registry(this.fileResolver).build();
    const collection = reg.collections.find(
      (c) => c.id === params.collectionId
    );
    if (!collection) throw new Error(`Collection ${params.collectionId} not found`);

    const results: any[] = [];
    for (const ep of reg.endpoints.filter((e) => e.collectionId === collection.id)) {
      try {
        const result = await this._bridgeRunEndpoint({
          endpointId: ep.id,
          envName: params.envName,
        });
        results.push(result);
      } catch (err: any) {
        results.push({ endpointId: ep.id, error: err.message });
      }
    }
    return { collectionId: params.collectionId, results, count: results.length };
  }

  private async _bridgeImpactReport(params: any): Promise<any> {
    const diff = await this._bridgeDiffEndpoint({
      endpointId: params.endpointId,
      snapshotA: params.snapshotA,
      snapshotB: params.snapshotB,
    });

    const report = {
      endpointId: params.endpointId,
      breakingCount: diff.summary.breaking,
      warningCount: diff.summary.warning,
      nonBreakingCount: diff.summary.nonBreaking,
      impactLevel: diff.summary.breaking > 0 ? "breaking" : diff.summary.warning > 0 ? "warning" : "non-breaking",
      affectedFields: diff.changes.map((c: any) => c.path),
      recommendations: diff.summary.breaking > 0
        ? ["Review breaking changes with API consumers before deploying"]
        : ["Changes are backward-compatible"],
    };

    return report;
  }

  private async _bridgeGenerateCode(params: any): Promise<any> {
    const store = new VsCodeSnapshotStore(path.join(this.workspaceRoot, ".apilot"));
    const snap = await store.latest(params.endpointId);
    if (!snap) throw new Error("No snapshot available. Run the endpoint first.");

    const schema = inferSchema(snap.body);
    const ep = this.registry.endpoints.find((e) => e.id === params.endpointId);
    if (!ep) throw new Error(`Endpoint ${params.endpointId} not found`);

    const engine = new CodegenEngine();
    const files = engine.generate({
      endpointId: params.endpointId,
      endpointName: ep.name,
      method: ep.method,
      url: ep.url,
      schema,
      language: params.language ?? "dart",
      outputPath: `.apilot/generated/${params.endpointId.replace(/\./g, "/")}`,
    });

    return {
      endpointId: params.endpointId,
      language: params.language ?? "dart",
      fileCount: files.length,
      files: files.map((f) => ({ path: f.path, language: f.language })),
    };
  }

  private async promptMissingSecrets(): Promise<void> {
    if (!this.hasApilotProject()) return;

    const registry = this.registry;
    for (const envEntry of registry.environments) {
      const raw = this.fileResolver.read(`.apilot/environments/${envEntry.name}.yaml`);
      if (!raw) continue;
      const env = parseEnvironmentFile(raw, `${envEntry.name}.yaml`);
      const missing = await VsCodeSecretStore.ensureSecrets(
        env,
        this.ctx.secrets
      );
      if (missing.length > 0) {
        await vscode.window.showWarningMessage(
          `Missing secrets for "${envEntry.name}": ${missing.join(", ")}`
        );
        await VsCodeSecretStore.promptSecrets(missing, this.ctx.secrets);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private async _pickEnvironment(): Promise<string | undefined> {
    const registry = this.registry;
    if (registry.environments.length === 0) {
      vscode.window.showWarningMessage("No environments found.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      registry.environments.map((e) => e.name),
      { placeHolder: "Select environment" }
    );
    return pick;
  }

  private _postMessage(
    panel: vscode.WebviewPanel,
    type: string,
    data: unknown
  ): void {
    panel.webview.postMessage({ type, data });
  }

  private async _handleWebviewMessage(
    panel: vscode.WebviewPanel,
    message: any
  ): Promise<void> {
    switch (message.type) {
      case "runEndpoint": {
        const result = await this._webviewRunEndpoint(
          message.data.endpointId, message.data.envName
        );
        this._postMessage(panel, "runResult", result);
        break;
      }
      case "runAll": {
        const result = await this._webviewRunAll();
        this._postMessage(panel, "runAllResult", result);
        break;
      }
      case "diffEndpoint": {
        const result = await this._webviewDiff(message.data.endpointId);
        this._postMessage(panel, "diffResult", result);
        break;
      }
      case "generateCode": {
        const result = await this._webviewGenerateCode(
          message.data.endpointId, message.data.language
        );
        this._postMessage(panel, "generateCodeResult", result);
        break;
      }
      case "refresh":
        this.refresh();
        const registry = new Registry(this.fileResolver).build();
        this._postMessage(panel, "registry", registry);
        break;
      case "openFile":
        const doc = await vscode.workspace.openTextDocument(
          path.join(this.workspaceRoot, message.data.file)
        );
        await vscode.window.showTextDocument(doc);
        break;
    }
  }

  private _getWebviewHtml(panel: vscode.WebviewPanel): string {
    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(
          this.ctx.extensionPath,
          "..",
          "..",
          "webview",
          "dist",
          "index.js"
        )
      )
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.file(
        path.join(
          this.ctx.extensionPath,
          "..",
          "..",
          "webview",
          "dist",
          "style.css"
        )
      )
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Apilot Dashboard</title>
  <link rel="stylesheet" href="${styleUri}">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';">
  <style>html,body{margin:0;padding:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}</style>
</head>
<body>
  <div id="root" style="height:100vh"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _getDiffHtml(diff: any): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Diff Result</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-editor-font-family); padding: 20px; }
  .summary { display: flex; gap: 16px; margin-bottom: 20px; }
  .badge { padding: 8px 16px; border-radius: 4px; font-weight: 600; }
  .breaking { background: #f8514920; color: #f85149; }
  .warning { background: #ff890020; color: #ff8900; }
  .nonBreaking { background: #2ea04320; color: #2ea043; }
  .change { border-bottom: 1px solid var(--vscode-editorWidget-border, #333); padding: 8px 0; }
  .path { font-family: monospace; color: #c9d1d9; }
</style>
</head><body>
<h1>Diff: ${diff.endpointId}</h1>
<div class="summary">
  <div class="badge ${diff.summary.breaking > 0 ? 'breaking' : ''}">${diff.summary.breaking} Breaking</div>
  <div class="badge ${diff.summary.warning > 0 ? 'warning' : ''}">${diff.summary.warning} Warnings</div>
  <div class="badge ${diff.summary.nonBreaking > 0 ? 'nonBreaking' : ''}">${diff.summary.nonBreaking} Non-breaking</div>
</div>
${diff.changes.map((c: any) => `
<div class="change">
  <span class="path">${c.path}</span>
  <span class="badge ${c.level}">${c.kind}</span>
  <span>${c.description}</span>
</div>
`).join("")}
</body></html>`;
  }

  private _ensureApilotFolder(): void {
    const apilotDir = path.join(this.workspaceRoot, ".apilot");
    if (!fs.existsSync(apilotDir)) {
      // Don't create automatically — let the user import or init
      return;
    }

    // Auto-install SKILL.md if missing (gives AI context about the project)
    const skillPath = path.join(apilotDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      const registry = this.registry;
      const skillContent = this._generateProjectSkill(registry);
      try {
        fs.writeFileSync(skillPath, skillContent, "utf-8");
      } catch {
        /* ignore — non-fatal */
      }
    }

    // Ensure snapshots dir exists
    fs.mkdirSync(path.join(apilotDir, "snapshots"), { recursive: true });
  }

  /** Generate a project-specific SKILL.md for AI context. */
  private _generateProjectSkill(registry: ProjectRegistry): string {
    const envNames = registry.environments.map((e) => e.name);
    const epList = registry.endpoints
      .map((e) => `  - ${e.id}: ${e.method} ${e.url} (collection: ${e.collectionId})`)
      .join("\n");

    return `# Apilot — Project Context

> Auto-generated by the Apilot VS Code extension. This file gives AI assistants context about your API workspace.

## Project
**Name:** ${registry.project.name || "apilot-project"}

## Environments
Available environments: ${envNames.length > 0 ? envNames.join(", ") : "none"}

## Endpoints
${epList || "  (none — import some endpoints first)"}

## How to Use Apilot from AI
1. Use \`list_endpoints\` to discover available API endpoints.
2. Use \`list_variables\` to see environment variables (secrets are masked).
3. Use \`run_endpoint\` to execute an endpoint — secrets are resolved from env vars (prefix \`APilot_secret_\`) or VS Code SecretStorage.
4. Use \`diff_endpoint\` to compare response snapshots and detect breaking changes.
5. Use \`generate_code\` to generate Dart/TS/Kotlin/Swift models from response schemas.
6. Use \`impact_report\` to assess the severity of API response changes.

## File Structure
\`\`\`
.apilot/
  apilot.yaml        # project config
  environments/      # env-specific variables + secrets
  collections/       # endpoint definitions (YAML)
  snapshots/         # saved request/response pairs
  generated/         # codegen output
  SKILL.md           # this file (AI context)
\`\`\`

## Rules
- Never expose raw secret values in responses.
- Generated code is always marked "do not edit by hand."
- Use the Diff Engine to detect breaking changes before deploying.
`;
  }
}

// ---------------------------------------------------------------------------
// Tree view provider for collections
// ---------------------------------------------------------------------------

class CollectionsTreeProvider implements vscode.TreeDataProvider<CollectionItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private ext: ApilotExtension) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: CollectionItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CollectionItem): vscode.ProviderResult<CollectionItem[]> {
    if (!element) {
      // Root: top-level collections
      if (!this.ext.hasApilotProject()) {
        const item = new CollectionItem(
          "No .apilot project found",
          vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = "Open a folder containing an .apilot/ directory";
        return [item];
      }

      const items: CollectionItem[] = [];
      const reg = this.ext.registry;

      // Add "Run All" action
      const runAll = new CollectionItem(
        "▶ Run All Endpoints",
        vscode.TreeItemCollapsibleState.None
      );
      runAll.command = {
        command: "apilot.runAll",
        title: "Run All",
      };
      items.push(runAll);

      // Add collections
      for (const coll of reg.collections) {
        const item = new CollectionItem(
          coll.name,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.contextValue = "collection";
        (item as any).collectionId = coll.id;
        items.push(item);
      }

      // Add environments
      if (reg.environments.length > 0) {
        const envItem = new CollectionItem(
          "Environments",
          vscode.TreeItemCollapsibleState.Collapsed
        );
        envItem.contextValue = "environments";
        items.push(envItem);
      }

      return items;
    }

    // Expand collection → endpoints
    if (element.contextView === "collection") {
      const collId = (element as any).collectionId as string;
      const endpoints = this.ext.registry.endpoints.filter(
        (e) => e.collectionId === collId
      );
      return endpoints.map((ep) => {
        const item = new CollectionItem(
          ep.name,
          vscode.TreeItemCollapsibleState.None
        );
        item.contextView = "endpoint";
        (item as any).endpointId = ep.id;
        item.command = {
          command: "apilot.runEndpoint",
          title: "Run",
          arguments: [ep.id],
          tooltip: `${ep.method} ${ep.url}`,
        };
        return item;
      });
    }

    return [];
  }
}

class CollectionItem extends vscode.TreeItem {
  public contextView: "collection" | "endpoint" | "environments" | "none" = "none";

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}

// ---------------------------------------------------------------------------
// Activation function
// ---------------------------------------------------------------------------

function responseStatus(status: number): string {
  if (status >= 200 && status < 300) return "✓ OK";
  if (status >= 400 && status < 500) return "⚠ Client Error";
  if (status >= 500) return "✗ Server Error";
  return `Status ${status}`;
}

function vscodeLanguage(lang: string): string {
  switch (lang) {
    case "dart": return "dart";
    case "typescript": return "typescript";
    case "kotlin": return "kotlin";
    case "swift": return "swift";
    default: return "plaintext";
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const ext = new ApilotExtension(ctx);
  ext.activate();
}

export function deactivate(): void {}
