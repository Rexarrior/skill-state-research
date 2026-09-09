import { describe, expect, test } from "bun:test";
import { createPlan } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministic order, layers, times, and critical path", () => {
    expect(createPlan({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 2 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 5 },
        deploy: { start: 5, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("breaks critical-path ties using the full sequence", () => {
    const plan = createPlan({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 1, dependsOn: ["z", "a"] },
    ] });
    expect(plan.criticalPath).toEqual(["a", "end"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] }).totalDuration).toBe(0);
  });

  test("rejects invalid schemas and cycles", () => {
    expect(() => createPlan({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }] })).toThrow("unknown task");
    expect(() => createPlan({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("a -> b -> a");
  });
});
