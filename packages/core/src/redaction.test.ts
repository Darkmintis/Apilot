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

  it("masks unknown values under sensitive keys", () => {
    const result = redactor.redactObject({ data: [{ secret: "hidden", refreshToken: "abc" }] }) as any;
    expect(result.data[0].secret).toBe("⟦REDACTED⟧");
    expect(result.data[0].refreshToken).toBe("⟦REDACTED⟧");
  });

  it("does not mutate non-sensitive fields", () => {
    const obj = { name: "Alice", id: 1, sortKey: "name" };
    const result = redactor.redactObject(obj) as Record<string, unknown>;
    expect(result.name).toBe("Alice");
    expect(result.id).toBe(1);
    expect(result.sortKey).toBe("name");
  });

  it("handles empty secret values gracefully", () => {
    const emptyRedactor = new Redactor({ secretValues: {} });
    expect(emptyRedactor.redactString("hello")).toBe("hello");
  });

  it("redacts sensitive URL query parameters by name", () => {
    const redactor = new Redactor({ secretValues: {} });
    const url = "https://api.example.com/callback?token=abc123&state=xyz&api_key=secret456";
    const result = redactor.redactString(url);
    expect(result).toContain("token=⟦REDACTED⟧");
    expect(result).toContain("api_key=⟦REDACTED⟧");
    expect(result).toContain("state=xyz");
  });

  it("redacts sensitive query params even when the secret value is unknown", () => {
    const redactor = new Redactor({ secretValues: { authToken: "super-secret-token-123" } });
    const url = "https://api.example.com/posts?access_token=unknown-value-789&userId=42";
    const result = redactor.redactString(url);
    expect(result).not.toContain("unknown-value-789");
    expect(result).toContain("access_token=⟦REDACTED⟧");
    expect(result).toContain("userId=42");
  });

  it("does not redact non-URL strings as URLs", () => {
    const redactor = new Redactor({ secretValues: {} });
    expect(redactor.redactString("not a url but has token=somevalue")).toBe("not a url but has token=somevalue");
  });

  it("preserves URL fragments and non-sensitive params", () => {
    const redactor = new Redactor({ secretValues: {} });
    const url = "https://api.example.com/posts?page=1&limit=10#section";
    const result = redactor.redactString(url);
    expect(result).toContain("page=1");
    expect(result).toContain("limit=10");
    expect(result).toContain("#section");
  });

  it("redacts cookies and session keys in objects", () => {
    const redactor = new Redactor({ secretValues: {} });
    const obj = { session: "abc123", jwt: "eyJ123", name: "Alice", cookie: "sess=xyz" };
    const result = redactor.redactObject(obj) as Record<string, unknown>;
    expect(result.session).toBe("⟦REDACTED⟧");
    expect(result.jwt).toBe("⟦REDACTED⟧");
    expect(result.cookie).toBe("⟦REDACTED⟧");
    expect(result.name).toBe("Alice");
  });

  it("does not redact non-sensitive keys ending in similar words", () => {    const redactor = new Redactor({ secretValues: {} });
    const obj = { sortKey: "name", data_token_id: 5, author: "me" };
    const result = redactor.redactObject(obj) as Record<string, unknown>;
    expect(result.sortKey).toBe("name");
    expect(result.data_token_id).toBe(5);
    expect(result.author).toBe("me");
  });
});
