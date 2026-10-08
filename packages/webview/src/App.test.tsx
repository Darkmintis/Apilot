import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";

const mockState = {
  hasProject: true,
  hasFolder: true,
  project: { name: "My API", defaultEnvironment: "dev" },
  env: "dev",
  environments: ["dev", "staging"],
  collections: [{ id: "orders", name: "Orders", path: ".apilot/collections/orders" }],
  endpoints: [
    { id: "orders.list", collectionId: "orders", name: "List orders", method: "GET", url: "{{baseUrl}}/orders", file: ".apilot/collections/orders/list.yaml", health: { state: "passed" as const } },
    { id: "orders.get", collectionId: "orders", name: "Get order", method: "GET", url: "{{baseUrl}}/orders/{{id}}", file: ".apilot/collections/orders/get.yaml", health: { state: "breaking" as const, status: 500 } },
  ],
};

const mockEndpointDetail = {
  id: "orders.get", file: ".apilot/collections/orders/get.yaml",
  definition: { name: "Get order", method: "GET", url: "{{baseUrl}}/orders/{{id}}", expect: { status: 200 } },
  snapshots: [], revisions: [{ revision: 1, timestamp: "2026-01-01T00:00:00Z", summary: "initial", definition: { name: "Get order", method: "GET", url: "{{baseUrl}}/orders/{{id}}" } }],
  latest: null,
};

vi.mock("./api", () => ({
  __esModule: true,
  call: vi.fn(),
  onHostMessage: vi.fn(() => () => {}),
  persisted: { get: vi.fn(() => ({ view: { kind: "home" } })), set: vi.fn() },
  unsaved: { current: false },
  HEALTH_LABEL: { none: "Never run", passed: "Matches baseline", failed: "Last run failed", breaking: "Breaking change", changed: "Changed (safe)" },
  pretty: (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2)),
  timeAgo: () => "just now",
}));

import App from "./App";
import { call, persisted } from "./api";

/** Set up `call` to handle state and endpoint requests. */
function mockCall(state: any = mockState, detail: any = mockEndpointDetail) {
  (call as any).mockImplementation((method: string) => {
    if (method === "state") return Promise.resolve(state);
    if (method === "endpoint") return Promise.resolve(detail);
    if (method === "confirm") return Promise.resolve(true);
    return Promise.resolve(undefined);
  });
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (persisted.get as any).mockReturnValue({ view: { kind: "home" } });
    window.innerWidth = 320;
    mockCall();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a spinner while loading state", () => {
    (call as any).mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(screen.getByText("Loading Apilot…")).toBeInTheDocument();
  });

  it("shows WelcomePage when no project exists", async () => {
    mockCall({ hasProject: false, hasFolder: true });
    render(<App />);
    await screen.findByText("Apilot");
    expect(screen.getByText("Initialize Apilot in this project")).toBeInTheDocument();
  });

  it("shows Overview with project name when project exists", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "My API" });
    expect(screen.getByText("Run all")).toBeInTheDocument();
    expect(screen.getByText("New endpoint")).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
  });

  it("shows 'Needs attention' section for breaking endpoints", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "My API" });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Get order")).toBeInTheDocument();
  });

  it("shows 'Nothing needs attention' when all endpoints pass", async () => {
    mockCall({ ...mockState, endpoints: [mockState.endpoints[0]] });
    render(<App />);
    await screen.findByText(/Nothing needs attention/);
  });

  it("renders stat chips with correct counts", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "My API" });
    const stats = document.querySelectorAll(".stat");
    expect(stats.length).toBe(5);
  });

  it("clicking 'New endpoint' switches to the new-endpoint view", async () => {
    render(<App />);
    await screen.findByText("New endpoint");
    const overviewBtn = screen.getAllByText("New endpoint")[0];
    await act(async () => {
      fireEvent.click(overviewBtn);
    });
    await waitFor(() => {
      expect(persisted.set).toHaveBeenCalledWith(
        expect.objectContaining({ view: { kind: "new" } })
      );
    });
  });

  it("clicking 'Import' switches to the import view", async () => {
    render(<App />);
    await screen.findByText("Import");
    const overviewBtn = screen.getAllByText("Import")[0];
    await act(async () => {
      fireEvent.click(overviewBtn);
    });
    await waitFor(() => {
      expect(persisted.set).toHaveBeenCalledWith(
        expect.objectContaining({ view: { kind: "import" } })
      );
    });
  });

  it("clicking an endpoint in attention list navigates to it", async () => {
    render(<App />);
    await screen.findByText("Get order");
    const row = screen.getByText("Get order").closest("button")!;
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => {
      expect(persisted.set).toHaveBeenCalledWith(
        expect.objectContaining({ view: { kind: "endpoint", id: "orders.get", tab: "changes" } })
      );
    });
  });
});
