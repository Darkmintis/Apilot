import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, importSpec, type SecretProvider } from "../src/index";

const TOKEN = "tok-super-secret-9f8e7d";
let server: Server;
let baseUrl = "";
let orderShape: Record<string, unknown> = { id: 7, total: 12.5, customer: "Ana" };

beforeAll(async () => {
  server = createServer((req, res) => {
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    res.setHeader("content-type", "application/json");
    if (!authed) return res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    if (req.url?.startsWith("/orders/7")) return res.end(JSON.stringify(orderShape));
    if (req.url?.startsWith("/orders")) return res.end(JSON.stringify([{ id: 7, echo: TOKEN }]));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "apilot-"));
  const vault = new Map<string, string>([["dev:authToken", TOKEN]]);
  const secrets: SecretProvider = {
    get: async (env, name) => vault.get(`${env}:${name}`),
    set: async (env, name, value) => void vault.set(`${env}:${name}`, value),
    delete: async (env, name) => void vault.delete(`${env}:${name}`),
  };
  const ws = new Workspace(root, { secrets });
  ws.init("test");
  return { ws, root, vault };
}

describe("Workspace end-to-end", () => {
  it("runs, chains, redacts, baselines, diffs, versions, and finds impact", async () => {
    const { ws, root } = makeWorkspace();
    await ws.setVariable("dev", "baseUrl", "text", baseUrl);

    ws.saveEndpoint({ collection: "orders", name: "List", method: "GET", url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{authToken}}" }, after: [{ set: { orderId: "$[0].id" } }] });
    ws.saveEndpoint({ collection: "orders", name: "Get", method: "GET", url: "{{baseUrl}}/orders/{{orderId}}", auth: { type: "bearer", token: "{{authToken}}" } });
    writeFileSync(join(root, ".apilot/collections/orders/_folder.yaml"), "order: [list, get]\n");

    const all = await ws.runAll("orders");
    expect(all.results.map((r) => [r.endpointId, r.status])).toEqual([["orders.list", 200], ["orders.get", 200]]);

    // Secrets never reach disk, even when the server echoes them back.
    const snapDir = join(root, ".apilot/snapshots/orders.list");
    for (const f of readdirSync(snapDir).filter((f) => f.endsWith(".json"))) {
      expect(readFileSync(join(snapDir, f), "utf-8")).not.toContain(TOKEN);
    }

    // First passing run becomes the baseline; a removed field is a breaking diff.
    expect(ws.snapshots("orders.get")[0]!.baseline).toBe(true);
    expect(() => ws.deleteSnapshot("orders.get", ws.snapshots("orders.get")[0]!.id)).toThrow(/baseline/);
    orderShape = { id: 7, total: 12.5 };
    const second = await ws.run("orders.get");
    expect(second.diff?.breaking).toBe(true);
    expect(second.diff?.changes[0]).toMatchObject({ path: "$.customer", kind: "fieldRemoved" });

    // Impact report finds code that reads the removed field.
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib/order.dart"), "final String customer;\n");
    expect(ws.impact("orders.get").matches).toMatchObject([{ file: "lib/order.dart", line: 1, field: "customer" }]);

    // Editing the request creates a revision with a readable summary.
    const { definition } = ws.endpoint("orders.get");
    ws.saveEndpoint({ ...definition, id: "orders.get", query: { expand: "items" } });
    const revs = ws.revisions("orders.get");
    expect(revs.map((r) => r.revision)).toEqual([2, 1]);
    expect(revs[0]!.summary).toBe("added query expand");
    expect(ws.diffRevisions("orders.get").changes).toEqual([{ field: "query.expand", change: "added", to: "items" }]);

    // Schema learns from every successful sample: `customer` is now optional.
    expect(ws.schema("orders.get").required).toEqual(["id", "total"]);
  });

  it("imports cURL without writing the token into the repo", async () => {
    const { ws, root, vault } = makeWorkspace();
    const res = await importSpec(ws, "curl", `curl -X POST 'https://api.shop.io/v1/orders?draft=1' -H 'Authorization: Bearer abc.def.ghi' --json '{"sku":"A1"}'`);
    const file = readFileSync(join(root, ".apilot/collections/imported/post-v1-orders.yaml"), "utf-8");
    expect(res.created).toEqual(["imported.post-v1-orders"]);
    expect(file).not.toContain("abc.def.ghi");
    expect(file).toContain("{{authToken}}");
    expect(vault.get("dev:authToken")).toBe("abc.def.ghi");
    // Deleting a secret variable also forgets its keychain value.
    await ws.deleteVariable("dev", "authToken");
    expect(vault.has("dev:authToken")).toBe(false);
    expect(ws.endpoint(res.created[0]!).definition).toMatchObject({ method: "POST", query: { draft: "1" }, body: { sku: "A1" } });
  });

  it("reports a missing secret clearly", async () => {
    const { ws, vault } = makeWorkspace();
    vault.clear();
    await ws.setVariable("dev", "baseUrl", "text", baseUrl);
    ws.saveEndpoint({ collection: "a", name: "Me", method: "GET", url: "{{baseUrl}}/orders", auth: { type: "bearer", token: "{{authToken}}" } });
    await expect(ws.run("a.me")).rejects.toThrow(/Missing secret value\(s\) for "dev": authToken/);
  });
});
