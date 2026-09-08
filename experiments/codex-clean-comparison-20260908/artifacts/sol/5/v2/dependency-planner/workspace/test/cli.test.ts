import { describe, expect, test } from "bun:test";
import { createSchedule, parseTasks } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    const tasks = parseTasks({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
      ],
    });

    expect(createSchedule(tasks)).toEqual({
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

  test("handles empty input and zero-duration disconnected tasks", () => {
    expect(createSchedule(parseTasks({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createSchedule(parseTasks({ tasks: [
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
      { id: "b", duration: 1 },
    ] }))).toMatchObject({
      order: ["a", "b", "z"],
      layers: [["a", "b"], ["z"]],
      totalDuration: 1,
      criticalPath: ["b"],
    });
  });

  test("rejects malformed tasks and reports a deterministic cycle", () => {
    expect(() => parseTasks({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => parseTasks({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
    expect(() => createSchedule(parseTasks({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] }))).toThrow("a -> b -> a");
  });
});

