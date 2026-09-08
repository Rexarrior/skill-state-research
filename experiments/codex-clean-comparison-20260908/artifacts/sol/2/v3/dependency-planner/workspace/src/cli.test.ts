import { describe, expect, test } from "bun:test";
import { createPlan } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers", () => {
    expect(
      createPlan([
        { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2, dependsOn: [] },
        { id: "docs", duration: 1, dependsOn: [] },
      ]),
    ).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        deploy: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const plan = createPlan([
      { id: "a", duration: 2, dependsOn: [] },
      { id: "b", duration: 2, dependsOn: [] },
      { id: "z", duration: 0, dependsOn: ["a", "b"] },
      { id: "c", duration: 2, dependsOn: [] },
    ]);

    expect(plan.totalDuration).toBe(2);
    expect(plan.criticalPath).toEqual(["a", "z"]);
  });

  test("handles an empty task set", () => {
    expect(createPlan([])).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });
  });
});
