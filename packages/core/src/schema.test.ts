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
    expect(schema.properties!["id"].type).toBe("integer");
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

  it("detects ISO dates and date-times (never as enums)", () => {
    const b = new SchemaBuilder();
    expect(b.infer(["2024-05-01T10:00:00Z", "2024-05-01T10:00:00.5+05:45", "2024-05-01T10:00:00Z", "2024-05-01T10:00:00Z"])).toMatchObject({ type: "string", format: "date-time" });
    expect(b.infer(["2024-05-01", "2024-05-02"])).toMatchObject({ format: "date" });
    expect(b.infer(["2024-05-01", "tomorrow"]).format).toBeUndefined();
    expect(b.infer(["2024-05-01T10:00:00Z", "2024-05-01T10:00:00Z", "2024-05-01T10:00:00Z", "2024-05-01T10:00:00Z"]).enum).toBeUndefined();
  });

  it("handles arrays with element schemas", () => {
    const schema = new SchemaBuilder().infer([
      [1, 2, 3.5],
    ]);
    expect(schema.type).toBe("array");
    expect(schema.items).toBeDefined();
    expect(schema.items!.type).toBe("number"); // ints + decimals widen to number
    expect(new SchemaBuilder().infer([[1, 2]]).items!.type).toBe("integer");
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
