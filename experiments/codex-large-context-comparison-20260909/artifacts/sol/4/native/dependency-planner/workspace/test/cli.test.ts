import { describe, expect, test } from "bun:test";
import { createPlan, PlannerError } from "../src/cli";

describe("createPlan", () => {
  test("plans deterministically with parallel layers and a lexical critical-path tie break", () => {
    expect(createPlan({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3 },
        { id: "lint", duration: 1 },
        { id: "build", duration: 2, dependsOn: ["lint"] },
      ],
    })).toEqual({
      order: ["lint", "build", "test", "ship"],
      layers: [["lint", "test"], ["build"], ["ship"]],
      earliest: {
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 0, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles empty input and zero-duration disconnected tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0 }] }).criticalPath)
      .toEqual(["a"]);
  });

  test("compares the entire critical path for zero-duration ties", () => {
    const plan = createPlan({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "z", duration: 1, dependsOn: ["a", "b"] },
    ] });
    expect(plan.criticalPath).toEqual(["a", "b", "z"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => createPlan({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] })).toThrow("dependency cycle: a -> c -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "duration must be a finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "depends on unknown task"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
  ])("rejects invalid input %#", (input, message) => {
    expect(() => createPlan(input)).toThrow(PlannerError);
    expect(() => createPlan(input)).toThrow(message as string);
  });
});
