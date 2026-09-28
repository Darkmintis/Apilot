import { describe, it, expect } from "vitest";
import { CodegenEngine, camelCase, snakeCase, pascalCase } from "../src/index";
import { inferSchema } from "@apilot/core";

describe("CodegenEngine", () => {
  const engine = new CodegenEngine();

  const schema = inferSchema({
    id: 1,
    name: "Alice",
    active: true,
    email: null,
    tags: ["dev", "admin"],
    profile: {
      bio: "Hello",
      followers: 42,
    },
  });

  it("generates Dart (freezed) code", () => {
    const files = engine.generate({
      endpointId: "users.list",
      endpointName: "List users",
      method: "GET",
      url: "https://api.example.com/users",
      schema,
      outputPath: "lib/api",
      language: "dart",
      flavor: "freezed",
    });
    expect(files.length).toBe(2);
    expect(files[0].language).toBe("dart");
    expect(files[0].content).toContain("class UsersList");
    expect(files[0].content).toContain("String name");
    expect(files[0].content).toContain("bool active");
    expect(files[0].content).toContain("dynamic? email");
    expect(files[1].content).toContain("UsersListApi");
  });

  it("generates TypeScript (zod) code", () => {
    const files = engine.generate({
      endpointId: "users.list",
      endpointName: "List users",
      method: "GET",
      url: "https://api.example.com/users",
      schema,
      outputPath: "src/api",
      language: "typescript",
    });
    expect(files[0].language).toBe("typescript");
    expect(files[0].content).toContain("export interface UsersList");
    expect(files[0].content).toContain("name:");
    expect(files[1].content).toContain("callApi");
  });

  it("generates Kotlin data class code", () => {
    const files = engine.generate({
      endpointId: "users.list",
      endpointName: "List users",
      method: "POST",
      url: "https://api.example.com/users",
      schema,
      outputPath: "src/main/kotlin",
      language: "kotlin",
    });
    expect(files[0].language).toBe("kotlin");
    expect(files[0].content).toContain("data class UsersList");
    expect(files[0].content).toContain("@SerialName");
  });

  it("generates Swift Codable code", () => {
    const files = engine.generate({
      endpointId: "users.list",
      endpointName: "List users",
      method: "GET",
      url: "https://api.example.com/users",
      schema,
      outputPath: "iOS/Models",
      language: "swift",
    });
    expect(files[0].language).toBe("swift");
    expect(files[0].content).toContain("struct UsersList: Codable");
    expect(files[0].content).toContain("CodingKeys");
  });

  it("detects unknown language", () => {
    expect(() =>
      engine.generate({
        endpointId: "test",
        endpointName: "Test",
        method: "GET",
        url: "/test",
        schema,
        outputPath: "out",
        // @ts-expect-error testing failure
        language: "rust",
      })
    ).toThrow(/No codegen template/);
  });

  it("diff-aware generation detects changes", () => {
    const opts = {
      endpointId: "test",
      endpointName: "Test",
      method: "GET",
      url: "/test",
      schema,
      outputPath: "out",
      language: "dart",
    };
    const r1 = engine.generateDiff(opts, undefined);
    expect(r1.changed).toBe(true);

    const r2 = engine.generateDiff(opts, schema);
    // Same schema → no changes
    expect(r2.changed).toBe(false);
    expect(r2.files).toHaveLength(0);
  });
});

describe("Name helpers", () => {
  it("camelCase converts snake_case", () => {
    expect(camelCase("order_id")).toBe("orderId");
    expect(camelCase("first_name")).toBe("firstName");
  });

  it("snakeCase converts camelCase", () => {
    expect(snakeCase("orderId")).toBe("order_id");
  });

  it("pascalCase converts snake_case", () => {
    expect(pascalCase("order_id")).toBe("OrderId");
    expect(pascalCase("orders.list")).toBe("OrdersList");
    expect(pascalCase("users.list")).toBe("UsersList");
  });
});
