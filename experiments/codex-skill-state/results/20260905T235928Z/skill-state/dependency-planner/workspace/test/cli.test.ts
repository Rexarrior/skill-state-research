import { describe, expect, test } from "bun:test";
import { createPlan, validate } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with concurrency and critical-path ties", () => {
    const tasks = validate({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["test", "build"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "docs", duration: 4 },
      { id: "lint", duration: 1 },
    ] });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 4 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["docs"],
    });
  });

  test("uses the lexicographically smallest full critical chain", () => {
    const tasks = validate({ tasks: [
      { id: "z", duration: 1, dependsOn: ["b", "c"] },
      { id: "b", duration: 2, dependsOn: ["a"] },
      { id: "c", duration: 2, dependsOn: ["a"] },
      { id: "a", duration: 1 },
    ] });
    expect(createPlan(tasks).criticalPath).toEqual(["a", "b", "z"]);
  });

  test("supports empty and zero-duration plans", () => {
    expect(createPlan(validate({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(validate({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] })).totalDuration).toBe(0);
  });

  test("rejects invalid schemas", () => {
    expect(() => validate({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validate({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("duplicate task id");
    expect(() => validate({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown id");
    expect(() => validate({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("cannot depend on itself");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validate({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> c -> b -> a");
  });
});

