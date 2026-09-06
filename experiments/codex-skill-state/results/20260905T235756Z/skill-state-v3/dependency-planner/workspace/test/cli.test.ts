import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with concurrency and critical-path tie breaking", () => {
    const tasks = validateInput({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 3, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 1 },
    ] });
    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles empty and zero-duration plans", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const result = createPlan(validateInput({ tasks: [
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
    ] }));
    expect(result.totalDuration).toBe(0);
    expect(result.criticalPath).toEqual(["a"]);
  });

  test("uses locale-independent lexical ordering", () => {
    const result = createPlan(validateInput({ tasks: [
      { id: "ä", duration: 1 },
      { id: "z", duration: 1 },
    ] }));
    expect(result.order).toEqual(["z", "ä"]);
    expect(result.criticalPath).toEqual(["z"]);
  });

  test("rejects malformed tasks", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] })).toThrow("unknown id");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });
});
