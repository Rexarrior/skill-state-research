import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("uses lexicographical topological order and parallel layers", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 2, dependsOn: ["build", "docs"] },
        { id: "docs", duration: 1 },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
      ],
    });
    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "ship"],
      layers: [["docs", "lint"], ["build"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        ship: { start: 4, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("chooses the lexicographically smallest full critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "z", duration: 1 },
        { id: "a", duration: 1 },
        { id: "end", duration: 0, dependsOn: ["z", "a"] },
      ],
    });
    expect(createPlan(tasks).criticalPath).toEqual(["a", "end"]);
  });

  test("handles empty plans and zero-duration tasks", () => {
    expect(createPlan([])).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    const plan = createPlan(validateInput({ tasks: [{ id: "a", duration: 0 }] }));
    expect(plan.totalDuration).toBe(0);
    expect(plan.criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });

  test("rejects invalid schemas", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow(
      "unknown dependency",
    );
    expect(() =>
      validateInput({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }),
    ).toThrow("duplicate task id");
  });
});
