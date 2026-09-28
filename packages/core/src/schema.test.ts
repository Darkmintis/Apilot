import { describe, it, expect } from "vitest";
import { SchemaBuilder, inferSchema } from "../src/schema";

describe("SchemaBuilder", () => {
  it("infers a simple object schema", () => {
    const schema = new SchemaBuilder().infer([
      { id: 1, name: "Alice", active: true },
    ]);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["id", "name", "active"]);
    expect(schema.properties).toBeDefined();
    expect(schema.properties!["id"].type).toBe("number");
    expect(schema.properties!["name"].type).toBe("string");
    expect(schema.properties!["active"].type).toBe("boolean");
  });

  it("detects nullable fields from mixed samples", () => {
    const schema = new SchemaBuilder().infer([
      { id: 1, name: "Alice" },
      { id: 2, name: null },
    ]);
    expect(schema.properties!["name"].nullable).toBe(true);
    expect(schema.required).not.toContain("name"); // not in all samples
  });

  it("detects enum values from constrained strings", () => {
    const schema = new SchemaBuilder().infer([
      "active", "pending", "active", "done", "pending",
    ]);
    expect(schema.enum).toBeDefined();
    expect(schema.enum).toContain("active");
    expect(schema.enum).toContain("done");
    expect(schema.enum).toContain("pending");
  });

  it("handles arrays with element schemas", () => {
    const schema = new SchemaBuilder().infer([
      [1, 2, 3],
    ]);
    expect(schema.type).toBe("array");
    expect(schema.items).toBeDefined();
    expect(schema.items!.type).toBe("number");
  });

  it("handles null input", () => {
    const schema = new SchemaBuilder().infer([null]);
    expect(schema.nullable).toBe(true);
  });

  it("handles nested objects", () => {
    const schema = inferSchema({
      data: {
        user: { id: 1, profile: { name: "test" } },
      },
    });
    expect(schema.type).toBe("object");
    expect(schema.properties!["data"].properties!["user"].properties!["profile"]
      .properties!["name"].type).toBe("string");
  });

  it("required fields are those present in ALL samples", () => {
    const schema = new SchemaBuilder().infer([
      { a: 1, b: 2 },
      { a: 1 },
    ]);
    expect(schema.required).toEqual(["a"]);
  });
});
