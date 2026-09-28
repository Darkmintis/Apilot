import { describe, it, expect } from "vitest";
import { parseEndpointFile, EndpointParseError } from "../src/file-format";

describe("parseEndpointFile", () => {
  it("parses a valid endpoint file", () => {
    const yaml = `
name: List orders
method: GET
url: "{{baseUrl}}/orders"
headers:
  Accept: application/json
query:
  page: "1"
  limit: "20"
expect:
  status: 200
  schema: ../../schemas/orders.list.json
`;
    const ep = parseEndpointFile(yaml, "orders/list.yaml");
    expect(ep.name).toBe("List orders");
    expect(ep.method).toBe("GET");
    expect(ep.url).toBe("{{baseUrl}}/orders");
    expect(ep.headers?.Accept).toBe("application/json");
    expect(ep.expect?.status).toBe(200);
  });

  it("throws on missing required field", () => {
    const yaml = `
name: Bad
# missing method and url
`;
    expect(() => parseEndpointFile(yaml, "bad.yaml")).toThrow(EndpointParseError);
  });

  it("throws on invalid method", () => {
    const yaml = `
name: Bad
method: FROBNICATE
url: /test
`;
    expect(() => parseEndpointFile(yaml, "bad.yaml")).toThrow(
      /Invalid method/
    );
  });

  it("supports body and auth", () => {
    const yaml = `
name: Create order
method: POST
url: "{{baseUrl}}/orders"
auth:
  type: bearer
  token: "{{authToken}}"
body: |
  {
    "product": "widget"
  }
after:
  - set: { orderId: "$.data.id" }
`;
    const ep = parseEndpointFile(yaml, "orders/create.yaml");
    expect(ep.method).toBe("POST");
    expect(ep.auth?.type).toBe("bearer");
    expect(ep.body).toContain("widget");
    expect(ep.after?.[0].set?.orderId).toBe("$.data.id");
  });

  it("normalizes lowercase methods to uppercase", () => {
    const yaml = `
name: Test
method: get
url: /test
`;
    const ep = parseEndpointFile(yaml, "test.yaml");
    expect(ep.method).toBe("GET");
  });
});
