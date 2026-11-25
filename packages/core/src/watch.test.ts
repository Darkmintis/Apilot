import { describe, expect, it } from "vitest";
import { isDue, summarizeWatch, watchMessage } from "./watch";
import type { RunAllResult } from "./workspace";

const item = (endpointId: string, o: object) => ({ endpointId, name: endpointId, method: "GET", passed: true, breaking: false, ...o });
const result = (results: RunAllResult["results"]): RunAllResult => ({ env: "dev", results, passed: 0, failed: 0, breaking: 0 });
const sum = (warning: number) => ({ breaking: 0, warning, nonBreaking: 0, info: 0 });

describe("watch summary", () => {
  it("is silent when nothing changed, ignoring skipped endpoints", () => {
    const s = summarizeWatch(result([item("a", {}), item("b", { skipped: true, passed: false })]));
    expect(s).toMatchObject({ checked: 1, skipped: 1, failed: [] });
    expect(watchMessage(s, "api")).toBeUndefined();
  });

  it("reports breaking, warning and failed endpoints once each", () => {
    const s = summarizeWatch(result([
      item("a", { breaking: true, passed: false }),
      item("b", { summary: sum(2) }),
      item("c", { passed: false }),
    ]));
    expect(s).toMatchObject({ breaking: ["a"], warning: ["b"], failed: ["a", "c"] });
    expect(watchMessage(s, "api")).toBe("Apilot (api): 1 with breaking changes, 1 with warnings, 1 failed of 3 checked endpoints.");
  });

  it("is due once per local day", () => {
    const noon = new Date(2026, 10, 25, 12);
    expect(isDue(undefined, noon)).toBe(true);
    expect(isDue(new Date(2026, 10, 25, 1).toISOString(), noon)).toBe(false);
    expect(isDue(new Date(2026, 10, 24, 23).toISOString(), noon)).toBe(true);
  });
});
