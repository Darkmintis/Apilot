import { describe, it, expect } from "vitest";
import { Redactor } from "../src/redaction";

describe("Redactor", () => {
  const redactor = new Redactor({
    secretValues: {
      authToken: "super-secret-token-123",
      password: "p@ssw0rd!",
    },
  });

  it("masks known secret values in strings", () => {
    const input = "Bearer super-secret-token-123 and password=p@ssw0rd!";
    const result = redactor.redactString(input);
    expect(result).not.toContain("super-secret-token-123");
    expect(result).not.toContain("p@ssw0rd!");
    expect(result).toContain("⟦REDACTED⟧");
  });

  it("masks JWT tokens by pattern", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQov";
    const result = redactor.redactString(`Authorization: Bearer ${jwt}`);
    expect(result).not.toContain(jwt);
    expect(result).toContain("⟦REDACTED⟧");
  });

  it("masks sensitive header keys", () => {
    const headers = {
      Authorization: "Bearer secret123",
      "X-API-Key": "key-abc-123",
      Accept: "application/json",
    };
    const result = redactor.redactHeaders(headers);
    // Authorization and api-key style headers are masked
    expect(result.Authorization).not.toBe("Bearer secret123");
    expect(result["X-API-Key"]).not.toBe("key-abc-123");
  });

  it("recursively redacts objects", () => {
    const obj = {
      user: {
        name: "Alice",
        password: "p@ssw0rd!",
        token: "super-secret-token-123",
      },
      data: [{ secret: "hidden" }],
    };
    const result = redactor.redactObject(obj) as Record<string, unknown>;
    expect((result.user as Record<string, unknown>).password).not.toBe("p@ssw0rd!");
    expect((result.user as Record<string, unknown>).token).not.toBe("super-secret-token-123");
  });

  it("does not mutate non-sensitive fields", () => {
    const obj = { name: "Alice", id: 1 };
    const result = redactor.redactObject(obj) as Record<string, unknown>;
    expect(result.name).toBe("Alice");
    expect(result.id).toBe(1);
  });

  it("handles empty secret values gracefully", () => {
    const emptyRedactor = new Redactor({ secretValues: {} });
    expect(emptyRedactor.redactString("hello")).toBe("hello");
  });
});
