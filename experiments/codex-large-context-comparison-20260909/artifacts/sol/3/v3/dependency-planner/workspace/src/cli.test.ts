import { describe, expect, test } from "bun:test";
import { createPlan, PlannerError } from "./cli";

describe("createPlan", () => {
  test("plans dependencies, concurrency, and lexicographic ties", () => {
    expect(createPlan({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["test", "build"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 2 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 3 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const result = createPlan({ tasks: [
      { id: "z", duration: 2 },
      { id: "a", duration: 1 },
      { id: "b", duration: 1, dependsOn: ["a"] },
    ] });
    expect(result.totalDuration).toBe(2);
    expect(result.criticalPath).toEqual(["a", "b"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(createPlan({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] }).criticalPath)
      .toEqual(["a"]);
  });

  test("validates schema", () => {
    const invalid = [
      {},
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] },
    ];
    for (const input of invalid) expect(() => createPlan(input)).toThrow(PlannerError);
  });

  test("reports a deterministic cycle with repeated endpoint", () => {
    expect(() => createPlan({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] })).toThrow("a -> c -> b -> a");
  });
});
