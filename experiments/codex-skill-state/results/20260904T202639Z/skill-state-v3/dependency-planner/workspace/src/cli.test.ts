import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
      ],
    });
    expect(createPlan(tasks)).toEqual({
      order: ["lint", "build", "test", "ship"],
      layers: [["lint"], ["build", "test"], ["ship"]],
      earliest: {
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports no tasks and zero-duration disconnected tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(validateInput({ tasks: [
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
      { id: "b", duration: 0 },
    ] })).criticalPath).toEqual(["a"]);
  });

  test("rejects invalid schemas", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] })).toThrow("unknown task");
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
