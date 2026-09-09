import { describe, expect, test } from "bun:test";
import { createSchedule, validateInput } from "../src/planner";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers", () => {
    const tasks = validateInput({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] });
    expect(createSchedule(tasks)).toEqual({
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

  test("chooses the lexicographically smallest full critical path", () => {
    const tasks = validateInput({ tasks: [
      { id: "z", duration: 1, dependsOn: ["b", "x"] },
      { id: "b", duration: 2, dependsOn: ["a"] },
      { id: "x", duration: 2, dependsOn: ["a"] },
      { id: "a", duration: 0 },
    ] });
    expect(createSchedule(tasks).criticalPath).toEqual(["a", "b", "z"]);
  });

  test("supports empty input", () => {
    expect(createSchedule(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createSchedule(tasks)).toThrow("cycle detected: a -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown dependency"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
  ] as const)("rejects invalid input %#", (input, message) => {
    expect(() => validateInput(input)).toThrow(message);
  });
});

