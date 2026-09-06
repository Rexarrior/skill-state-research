import { describe, expect, test } from "bun:test";
import { planInput, validateInput } from "../src/planner";

describe("dependency planner", () => {
  test("plans deterministically with parallel work", () => {
    expect(planInput({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] })).toEqual({
      order: ["lint", "build", "test", "deploy"],
      layers: [["lint"], ["build", "test"], ["deploy"]],
      earliest: {
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 5 },
        deploy: { start: 5, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const plan = planInput({ tasks: [
      { id: "z", duration: 1, dependsOn: ["b", "c"] },
      { id: "b", duration: 2, dependsOn: ["a"] },
      { id: "c", duration: 2, dependsOn: ["a"] },
      { id: "a", duration: 1 },
    ] });
    expect(plan.criticalPath).toEqual(["a", "b", "z"]);
  });

  test("supports empty input, disconnected tasks, and zero durations", () => {
    expect(planInput({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const plan = planInput({ tasks: [
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
      { id: "c", duration: 0 },
    ] });
    expect(plan.order).toEqual(["a", "b", "c"]);
    expect(plan.layers).toEqual([["a", "c"], ["b"]]);
    expect(plan.criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("dependency cycle: a -> b -> a");
  });

  test.each([
    [{}, '"tasks" array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: Number.NaN }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x", "x"] }] }, "duplicate id"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
  ])("rejects invalid input", (input, message) => {
    expect(() => validateInput(input)).toThrow(message as string);
  });
});
