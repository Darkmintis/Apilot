/**
 * Mock server controller: starts a project's mock API on this machine's
 * network address so a phone or emulator can call it like a real backend.
 */

import * as vscode from "vscode";
import * as os from "node:os";
import { startMockServer, type MockHandle, type ProjectEntry, type ProjectHub } from "@apilot/core";

export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

export class MockController implements vscode.Disposable {
  private handle: MockHandle | undefined;
  private readonly log = vscode.window.createOutputChannel("Apilot Mock");
  private readonly bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);

  constructor(private readonly hub: ProjectHub) {
    this.bar.command = "apilot.mock.stop";
  }

  async start(project: ProjectEntry): Promise<void> {
    if (this.handle) await this.stop();
    const cfg = vscode.workspace.getConfiguration("apilot.mock");
    const host = cfg.get<boolean>("lan") === false ? "127.0.0.1" : "0.0.0.0";
    const ws = this.hub.workspace(project.id);
    const options = { host, onRequest: (e: { method: string; path: string; status: number; endpointId?: string }) => this.log.appendLine(`${e.status} ${e.method} ${e.path}${e.endpointId ? `  → ${e.endpointId}` : ""}`) };
    const wanted = cfg.get<number>("port") ?? 4010;
    try {
      this.handle = await startMockServer(ws, { ...options, port: wanted });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      this.handle = await startMockServer(ws, { ...options, port: 0 });
    }
    const { port, routes } = this.handle;
    const urls = host === "0.0.0.0" ? lanAddresses().map((a) => `http://${a}:${port}`) : [];
    const local = `http://localhost:${port}`;
    this.log.appendLine(`Mock server for "${project.name}" is running (${routes.length} routes).`);
    this.log.appendLine(`  This machine:      ${local}`);
    for (const u of urls) this.log.appendLine(`  Phone, same Wi-Fi: ${u}`);
    this.log.appendLine(`  Android emulator:  http://10.0.2.2:${port}`);
    this.log.appendLine("Set your app's base URL to one of these. Responses come from each endpoint's mock: block, else its baseline.");
    this.bar.text = `$(radio-tower) Mock :${port}`;
    this.bar.tooltip = "Apilot mock server running — click to stop";
    this.bar.show();
    const pick = await vscode.window.showInformationMessage(
      `Apilot mock server running on port ${port}.${urls[0] ? ` Phones on your network: ${urls[0]}` : ""}`,
      "Copy URL",
      "Show Log"
    );
    if (pick === "Copy URL") await vscode.env.clipboard.writeText(urls[0] ?? local);
    if (pick === "Show Log") this.log.show(true);
  }

  async stop(): Promise<void> {
    const h = this.handle;
    this.handle = undefined;
    this.bar.hide();
    if (!h) return;
    await h.close();
    this.log.appendLine("Mock server stopped.");
  }

  dispose(): void {
    void this.stop();
    this.log.dispose();
    this.bar.dispose();
  }
}
