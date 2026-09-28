import { describe, it, expect } from "vitest";
import { interpolate, referencedVars, VariableError } from "../src/variables";

describe("interpolate", () => {
  it("replaces {{var}} placeholders", () => {
    const result = interpolate("https://{{host}}/api/v{{version}}/users", {
      host: "api.test.com",
      version: "2",
    });
    expect(result).toBe("https://api.test.com/api/v2/users");
  });

  it("supports whitespace inside braces", () => {
    const result = interpolate("https://{{ host }}/path", { host: "x.com" });
    expect(result).toBe("https://x.com/path");
  });

  it("throws VariableError for undefined vars", () => {
    expect(() => interpolate("https://{{missing}}/path", {})).toThrow(
      VariableError
    );
  });

  it("leaves strings without placeholders unchanged", () => {
    expect(interpolate("hello world", {})).toBe("hello world");
  });
});

describe("referencedVars", () => {
  it("extracts all variable names", () => {
    const vars = referencedVars("{{baseUrl}}/users/{{userId}}/posts?{{q}}");
    expect(vars.sort()).toEqual(["baseUrl", "q", "userId"]);
  });

  it("returns empty for no variables", () => {
    expect(referencedVars("https://api.test.com/path")).toEqual([]);
  });
});
