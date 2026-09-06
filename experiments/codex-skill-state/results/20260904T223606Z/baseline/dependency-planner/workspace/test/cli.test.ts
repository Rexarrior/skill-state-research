import { describe, expect, test } from "bun:test";
import { createPlan, findCycle, parseTasks } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministic layers, timings, and a tie-broken critical path", () => {
    const plan = createPlan(parseTasks({ tasks: [
      { id: "deploy", duration: 1, dependsOn: ["build", "docs"] },
      { id: "lint", duration: 2 },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "docs", duration: 5 }
    ] }));
    expect(plan.order).toEqual(["docs", "lint", "build", "deploy"]);
    expect(plan.layers).toEqual([["docs", "lint"], ["build"], ["deploy"]]);
    expect(plan.earliest).toEqual({ docs: { start: 0, finish: 5 }, lint: { start: 0, finish: 2 }, build: { start: 2, finish: 5 }, deploy: { start: 5, finish: 6 } });
    expect(plan.totalDuration).toBe(6);
    expect(plan.criticalPath).toEqual(["docs", "deploy"]);
  });

  test("supports empty and zero-duration plans", () => {
    expect(createPlan(parseTasks({ tasks: [] }))).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(createPlan(parseTasks({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] })).layers).toEqual([["a"], ["b"]]);
  });

  test("validates references and produces a stable concrete cycle", () => {
    expect(() => parseTasks({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown task");
    const tasks = parseTasks({ tasks: [{ id: "c", duration: 1, dependsOn: ["a"] }, { id: "b", duration: 1, dependsOn: ["c"] }, { id: "a", duration: 1, dependsOn: ["b"] }] });
    expect(findCycle(tasks)).toEqual(["a", "b", "c", "a"]);
    expect(() => createPlan(tasks)).toThrow("a -> b -> c -> a");
  });
});
