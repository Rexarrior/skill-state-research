import { describe, expect, test } from "bun:test";
import { InputError, plan } from "./cli";

describe("dependency planner", () => {
  test("plans a graph deterministically with concurrency and timings", () => {
    expect(
      plan({
        tasks: [
          { id: "package", duration: 2, dependsOn: ["build", "test"] },
          { id: "test", duration: 4, dependsOn: ["lint"] },
          { id: "build", duration: 3, dependsOn: ["lint"] },
          { id: "lint", duration: 1 },
          { id: "docs", duration: 2 },
        ],
      }),
    ).toEqual({
      order: ["docs", "lint", "build", "test", "package"],
      layers: [["docs", "lint"], ["build", "test"], ["package"]],
      earliest: {
        build: { start: 1, finish: 4 },
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        package: { start: 5, finish: 7 },
        test: { start: 1, finish: 5 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "package"],
    });
  });

  test("chooses the lexicographically smallest full critical path", () => {
    const result = plan({
      tasks: [
        { id: "z", duration: 2 },
        { id: "aa", duration: 2 },
        { id: "end", duration: 1, dependsOn: ["z", "aa"] },
      ],
    });

    expect(result.criticalPath).toEqual(["aa", "end"]);
    expect(result.totalDuration).toBe(3);
  });

  test("handles empty input and zero-duration tasks", () => {
    expect(plan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const result = plan({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    });
    expect(result.layers).toEqual([["a"], ["b"]]);
    expect(result.totalDuration).toBe(0);
    expect(result.criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      plan({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["b"] },
          { id: "b", duration: 1, dependsOn: ["a"] },
          { id: "a", duration: 1, dependsOn: ["c"] },
        ],
      }),
    ).toThrow("cycle detected: a -> c -> b -> a");
  });

  test("rejects schema errors", () => {
    const invalidInputs = [
      {},
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      {
        tasks: [
          { id: "a", duration: 1 },
          { id: "a", duration: 2 },
        ],
      },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }] },
    ];

    for (const input of invalidInputs) {
      expect(() => plan(input)).toThrow(InputError);
    }
  });
});
