import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const root = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;

async function waitFor<T>(fn: () => T | false | undefined | "", ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite("Apilot extension", () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension("apilot-dev.apilot")!.activate();
  });

  test("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ["apilot.open", "apilot.init", "apilot.runEndpoint", "apilot.runAll", "apilot.import", "apilot.setupAi"]) {
      assert.ok(all.includes(c), `${c} missing`);
    }
  });

  test("sets up AI skills without a connect step", async () => {
    const skill = await waitFor(() => {
      const f = path.join(root(), ".cursor/skills/apilot/SKILL.md");
      return fs.existsSync(f) && fs.readFileSync(f, "utf-8");
    });
    assert.match(skill, /^---\nname: apilot\n/);
    assert.ok(fs.existsSync(path.join(root(), ".claude/skills/apilot/SKILL.md")));
  });

  test("bridge runs tools for the MCP server and rejects bad tokens", async () => {
    const file = path.join(root(), ".apilot/.local/bridge.json");
    const { port, token } = JSON.parse(await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, "utf-8")));
    const call = (auth: string) =>
      fetch(`http://127.0.0.1:${port}/call`, { method: "POST", headers: { Authorization: auth }, body: JSON.stringify({ name: "list_endpoints", args: {} }) });

    assert.strictEqual((await call("Bearer nope")).status, 401);
    const res = (await (await call(`Bearer ${token}`)).json()) as { result: { endpoints: { id: string }[] } };
    assert.ok(res.result.endpoints.some((e) => e.id === "orders.list"));

    const secret = (await (await fetch(`http://127.0.0.1:${port}/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "set_variable", args: { name: "authToken", type: "secret", value: "x" } }),
    })).json()) as { error?: string };
    assert.match(secret.error ?? "", /Secret values can't be set/);
  });

  test("opens the panel", async () => {
    await vscode.commands.executeCommand("apilot.open", "orders.list");
    await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === "Apilot"));
  });
});
