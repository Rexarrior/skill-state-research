import { describe, expect, test } from "bun:test";
import { createPlan, PlannerError } from "./cli";

describe("createPlan", () => {
  test("plans dependencies, concurrency, and a deterministic critical path", () => {
    expect(
      createPlan({
        tasks: [
          { id: "ship", duration: 1, dependsOn: ["build", "docs"] },
          { id: "docs", duration: 2 },
          { id: "build", duration: 3, dependsOn: ["lint"] },
          { id: "lint", duration: 1 },
        ],
      }),
    ).toEqual({
      order: ["docs", "lint", "build", "ship"],
      layers: [["docs", "lint"], ["build"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("uses the lexicographically smallest full critical path", () => {
    const result = createPlan({
      tasks: [
        { id: "z", duration: 2 },
        { id: "a", duration: 1 },
        { id: "b", duration: 1, dependsOn: ["a"] },
      ],
    });

    expect(result.totalDuration).toBe(2);
    expect(result.criticalPath).toEqual(["a", "b"]);
  });

  test("handles empty plans and zero-duration dependencies", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    expect(
      createPlan({
        tasks: [
          { id: "z", duration: 1, dependsOn: ["a"] },
          { id: "a", duration: 0 },
        ],
      }).criticalPath,
    ).toEqual(["a", "z"]);

    expect(
      createPlan({
        tasks: [
          { id: "a", duration: 1, dependsOn: ["z"] },
          { id: "z", duration: 0 },
        ],
      }).criticalPath,
    ).toEqual(["z", "a"]);
  });

  test("rejects malformed tasks and unknown dependencies", () => {
    expect(() => createPlan({ tasks: [{ id: "a", duration: -1 }] })).toThrow(PlannerError);
    expect(() =>
      createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }),
    ).toThrow("unknown task missing");
    expect(() =>
      createPlan({
        tasks: [
          { id: "a", duration: 1 },
          { id: "a", duration: 2 },
        ],
      }),
    ).toThrow("duplicate task id");
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      createPlan({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["b"] },
          { id: "b", duration: 1, dependsOn: ["a"] },
          { id: "a", duration: 1, dependsOn: ["c"] },
        ],
      }),
    ).toThrow("cycle detected: a -> c -> b -> a");
  });

  test("supports ids that coincide with object prototype properties", () => {
    const result = createPlan({
      tasks: [
        { id: "done", duration: 1, dependsOn: ["__proto__"] },
        { id: "__proto__", duration: 2 },
      ],
    });

    expect(Object.hasOwn(result.earliest, "__proto__")).toBe(true);
    expect(result.earliest.__proto__).toEqual({ start: 0, finish: 2 });
    expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  });
});
