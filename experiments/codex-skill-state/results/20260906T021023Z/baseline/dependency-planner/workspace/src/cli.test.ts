import { describe, expect, test } from "bun:test";
import { createPlan } from "./cli";

describe("createPlan", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    expect(
      createPlan({
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

  test("handles empty input and zero-duration tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    expect(
      createPlan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] }),
    ).toMatchObject({ totalDuration: 0, criticalPath: ["a"] });
  });

  test("chooses the lexicographically smallest full critical path", () => {
    expect(
      createPlan({
        tasks: [
          { id: "x", duration: 1, dependsOn: ["b", "a"] },
          { id: "b", duration: 2 },
          { id: "a", duration: 2 },
        ],
      }).criticalPath,
    ).toEqual(["a", "x"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      createPlan({
        tasks: [
          { id: "b", duration: 1, dependsOn: ["a"] },
          { id: "a", duration: 1, dependsOn: ["b"] },
        ],
      }),
    ).toThrow("dependency cycle: a -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id: a"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "duration must be a finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: null }] }, "dependsOn must be an array"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "dependsOn contains duplicate id: b"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "depends on unknown id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
  ])("rejects invalid input", (input, message) => {
    expect(() => createPlan(input)).toThrow(message as string);
  });
});
