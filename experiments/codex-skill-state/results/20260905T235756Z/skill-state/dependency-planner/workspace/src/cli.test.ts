import { describe, expect, test } from "bun:test";
import { plan } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel work and a critical-path tie", () => {
    expect(plan({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["docs", "build"] },
      { id: "docs", duration: 3 },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "ship"],
      layers: [["docs", "lint"], ["build"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 3 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["docs", "ship"],
    });
  });

  test("supports empty input and zero-duration paths", () => {
    expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(plan({ tasks: [
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
    ] }).criticalPath).toEqual(["a"]);
  });

  test("rejects invalid dependencies", () => {
    expect(() => plan({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown dependency");
    expect(() => plan({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("cannot depend on itself");
    expect(() => plan({ tasks: [{ id: "a", duration: Number.NaN }] })).toThrow("finite non-negative");
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => plan({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("a -> b -> a");
  });
});
