import { describe, expect, test } from "bun:test";
import { createPlan, parseInput } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel work and tie-broken critical paths", () => {
    const tasks = parseInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 0 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles an empty task list", () => {
    expect(createPlan(parseInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test("rejects schema errors", () => {
    expect(() => parseInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => parseInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }] })).toThrow("unknown task");
    expect(() => parseInput({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("duplicate task id");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = parseInput({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });
});
