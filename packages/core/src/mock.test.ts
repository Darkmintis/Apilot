import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, startMockServer, matchRoute, routeSegments, type MockHandle } from "../src/index";

describe("mock routes", () => {
  const route = (id: string, url: string) => ({ id, method: "GET" as const, segments: routeSegments(url) });

  it("drops the host or base variable and keeps placeholders", () => {
    expect(routeSegments("{{baseUrl}}/orders/{{id}}?x=1")).toEqual(["orders", "{{id}}"]);
    expect(routeSegments("https://api.example.com/v1/orders/:id")).toEqual(["v1", "orders", ":id"]);
  });

  it("prefers the most specific route and tolerates a base-path prefix", () => {
    const routes = [route("byId", "{{baseUrl}}/orders/{{id}}"), route("latest", "{{baseUrl}}/orders/latest"), route("root", "{{baseUrl}}/")];
    expect(matchRoute(routes, "GET", "/orders/latest")?.id).toBe("latest");
    expect(matchRoute(routes, "GET", "/orders/42")?.id).toBe("byId");
    expect(matchRoute(routes, "GET", "/v1/orders/42")?.id).toBe("byId");
    expect(matchRoute(routes, "GET", "/")?.id).toBe("root");
    expect(matchRoute(routes, "GET", "/other")).toBeUndefined();
    expect(matchRoute(routes, "POST", "/orders/42")).toBeUndefined();
  });
});

describe("mock server", () => {
  let handle: MockHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("serves a mock block, then a baseline, and explains what is missing", async () => {
    const ws = new Workspace(mkdtempSync(join(tmpdir(), "apilot-mock-")));
    ws.init("t");
    ws.deleteEndpoint("example.get-todo");
    ws.saveEndpoint({ collection: "orders", name: "Get", method: "GET", url: "{{baseUrl}}/orders/{{id}}", mock: { status: 201, body: { id: 7 }, headers: { "x-mock": "1" } } });
    ws.saveEndpoint({ collection: "orders", name: "Bare", method: "GET", url: "{{baseUrl}}/bare" });
    const log: number[] = [];
    handle = await startMockServer(ws, { host: "127.0.0.1", onRequest: (e) => log.push(e.status) });
    const base = `http://127.0.0.1:${handle.port}`;

    const ok = await fetch(`${base}/orders/7?x=1`);
    expect([ok.status, ok.headers.get("x-mock"), ok.headers.get("content-type"), await ok.json()]).toEqual([201, "1", "application/json", { id: 7 }]);

    const bare = await fetch(`${base}/bare`);
    expect(bare.status).toBe(404);
    expect(((await bare.json()) as { hint: string }).hint).toContain("no mock and no baseline");

    // A baseline is picked up without restarting the server.
    ws.store.setBaseline("orders.bare", ws.store.save({ id: "s1", endpointId: "orders.bare", timestamp: new Date().toISOString(), request: { method: "GET", url: "x", headers: {}, body: null }, status: 200, headers: {}, body: { ok: true }, bodyRaw: "{}", timeMs: 1, size: 2, passed: true, failures: [] }, {}).id);
    expect(await (await fetch(`${base}/bare`)).json()).toEqual({ ok: true });

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/orders/7`, { method: "OPTIONS" })).status).toBe(204);
    expect(log).toEqual([201, 404, 200, 404, 204]);
  });
});
