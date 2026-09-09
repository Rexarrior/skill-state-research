import { describe, expect, test } from "bun:test";
import { PlannerError, validateAndPlan } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a tied critical path", () => {
    const plan = validateAndPlan({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "docs"] },
        { id: "docs", duration: 3 },
        { id: "lint", duration: 1 },
        { id: "build", duration: 2, dependsOn: ["lint"] },
      ],
    });

    expect(plan).toEqual({
      order: ["docs", "lint", "build", "ship"],
      layers: [["docs", "lint"], ["build"], ["ship"]],
      earliest: {
        build: { start: 1, finish: 3 },
        docs: { start: 0, finish: 3 },
        lint: { start: 0, finish: 1 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["docs", "ship"],
    });
  });

  test("supports empty plans and zero-duration tasks", () => {
    expect(validateAndPlan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    expect(
      validateAndPlan({
        tasks: [
          { id: "b", duration: 0, dependsOn: ["a"] },
          { id: "a", duration: 0 },
        ],
      }).criticalPath,
    ).toEqual(["a"]);
  });

  test("supports ids that are special object property names", () => {
    const plan = validateAndPlan({
      tasks: [{ id: "__proto__", duration: 1 }],
    });
    expect(JSON.parse(JSON.stringify(plan)).earliest).toEqual(
      JSON.parse('{"__proto__":{"start":0,"finish":1}}'),
    );
  });

  test("chooses the lexicographically smallest complete path on ties", () => {
    const plan = validateAndPlan({
      tasks: [
        { id: "z", duration: 2 },
        { id: "a", duration: 1 },
        { id: "c", duration: 1, dependsOn: ["a"] },
      ],
    });
    expect(plan.totalDuration).toBe(2);
    expect(plan.criticalPath).toEqual(["a", "c"]);
  });

  test("compares full tied paths when one predecessor path is a prefix", () => {
    const plan = validateAndPlan({
      tasks: [
        { id: "a", duration: 1 },
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "z", duration: 1, dependsOn: ["a", "b"] },
      ],
    });
    expect(plan.criticalPath).toEqual(["a", "b", "z"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      validateAndPlan({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["b"] },
          { id: "b", duration: 1, dependsOn: ["c"] },
          { id: "a", duration: 1 },
        ],
      }),
    ).toThrow("dependency cycle: b -> c -> b");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [
      { tasks: [{ id: "a", duration: Number.POSITIVE_INFINITY }] },
      "duration must be a finite non-negative number",
    ],
    [
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      "references unknown dependency",
    ],
  ])("rejects invalid schemas", (input, message) => {
    expect(() => validateAndPlan(input)).toThrow(message as string);
  });

  test("uses a dedicated error type for user errors", () => {
    expect(() => validateAndPlan(null)).toThrow(PlannerError);
  });
});
