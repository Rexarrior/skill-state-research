import { describe, expect, test } from "bun:test";
import { plan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
      ],
    });

    expect(plan(tasks)).toEqual({
      order: ["lint", "build", "test", "ship"],
      layers: [["lint"], ["build", "test"], ["ship"]],
      earliest: {
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles empty input, disconnected tasks, and zero durations", () => {
    expect(plan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(plan(validateInput({ tasks: [
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "b", duration: 2 },
      { id: "a", duration: 0 },
    ] }))).toEqual({
      order: ["a", "b", "z"],
      layers: [["a", "b"], ["z"]],
      earliest: {
        a: { start: 0, finish: 0 },
        b: { start: 0, finish: 2 },
        z: { start: 0, finish: 0 },
      },
      totalDuration: 2,
      criticalPath: ["b"],
    });
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["a"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => plan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });

  test("rejects malformed task data", () => {
    expect(() => validateInput({})).toThrow('"tasks" array');
    expect(() => validateInput({ tasks: [{ id: "", duration: 1 }] })).toThrow("non-empty string");
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("non-negative");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }))
      .toThrow("unknown task");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }))
      .toThrow("cannot depend on itself");
  });
});

