import { describe, expect, test } from "bun:test";
import { createPlan, parseTasks } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    const tasks = parseTasks({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty input and zero-duration chains", () => {
    expect(createPlan(parseTasks({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(parseTasks({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    })).criticalPath).toEqual(["a"]);
  });

  test("rejects malformed tasks", () => {
    expect(() => parseTasks({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => parseTasks({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] })).toThrow("unknown task");
    expect(() => parseTasks({ tasks: [
      { id: "a", duration: 1 },
      { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = parseTasks({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("a -> b -> a");
  });
});
