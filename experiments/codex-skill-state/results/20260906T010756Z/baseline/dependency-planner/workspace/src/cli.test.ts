import { describe, expect, test } from "bun:test";
import { planInput } from "./cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a critical-path tie", () => {
    expect(
      planInput({
        tasks: [
          { id: "ship", duration: 1, dependsOn: ["test", "build"] },
          { id: "test", duration: 2, dependsOn: ["lint"] },
          { id: "build", duration: 2, dependsOn: ["lint"] },
          { id: "lint", duration: 1 },
        ],
      }),
    ).toEqual({
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

  test("handles empty input and disconnected zero-duration tasks", () => {
    expect(planInput({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(planInput({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0 }] })).toEqual({
      order: ["a", "z"],
      layers: [["a", "z"]],
      earliest: { a: { start: 0, finish: 0 }, z: { start: 0, finish: 0 } },
      totalDuration: 0,
      criticalPath: ["a"],
    });
  });

  test("rejects invalid dependencies", () => {
    expect(() => planInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }))
      .toThrow("unknown task");
    expect(() => planInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }))
      .toThrow("cannot depend on itself");
    expect(() => planInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }))
      .toThrow("duplicate id");
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planInput({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    })).toThrow("dependency cycle: a -> b -> a");
  });

  test("compares full critical paths when one predecessor path is a prefix", () => {
    expect(planInput({
      tasks: [
        { id: "a", duration: 1 },
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "z", duration: 1, dependsOn: ["a", "b"] },
      ],
    }).criticalPath).toEqual(["a", "b", "z"]);
  });
});
