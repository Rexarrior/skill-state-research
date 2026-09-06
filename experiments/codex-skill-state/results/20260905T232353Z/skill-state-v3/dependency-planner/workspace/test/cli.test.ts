import { describe, expect, test } from "bun:test";
import { plan, validateInput } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel work and a critical-path tie", () => {
    expect(
      plan({
        tasks: [
          { id: "ship", duration: 1, dependsOn: ["test", "docs"] },
          { id: "test", duration: 2, dependsOn: ["build"] },
          { id: "docs", duration: 5 },
          { id: "build", duration: 3 },
        ],
      }),
    ).toEqual({
      order: ["build", "docs", "test", "ship"],
      layers: [["build", "docs"], ["test"], ["ship"]],
      earliest: {
        build: { start: 0, finish: 3 },
        docs: { start: 0, finish: 5 },
        test: { start: 3, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["build", "test", "ship"],
    });
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(plan({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0 }] }).criticalPath)
      .toEqual(["a"]);
  });

  test("critical path includes the predecessor responsible for a positive start", () => {
    const input = {
      tasks: [
        { id: "z", duration: 4 },
        { id: "a", duration: 1, dependsOn: ["z"] },
      ],
    };
    const result = plan(input);

    expect(result.criticalPath).toEqual(["z", "a"]);
    const durations = new Map(input.tasks.map((task) => [task.id, task.duration]));
    expect(result.criticalPath.reduce((sum, id) => sum + durations.get(id)!, 0))
      .toBe(result.totalDuration);
  });

  test("validates ids, durations, and dependencies", () => {
    expect(() => validateInput({ tasks: [{ id: "", duration: 1 }] })).toThrow();
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow();
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }] })).toThrow();
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow();
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => plan({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("dependency cycle: a -> b -> a");
  });
});
