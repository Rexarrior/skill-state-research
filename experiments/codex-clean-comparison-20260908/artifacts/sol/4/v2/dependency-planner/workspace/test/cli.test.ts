import { describe, expect, test } from "bun:test";
import { createPlan } from "../src/cli";

describe("createPlan", () => {
  test("plans deterministically with parallel layers and a lexical critical-path tie-break", () => {
    expect(createPlan({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["test", "build"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 0 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles an empty task set", () => {
    expect(createPlan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: Number.NaN }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
  ])("rejects invalid input", (input, message) => {
    expect(() => createPlan(input)).toThrow(message as string);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => createPlan({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("dependency cycle: a -> b -> a");
  });
});
