import { describe, expect, test } from "bun:test";
import { createPlan, InputError, validateInput } from "./cli";

describe("createPlan", () => {
  test("uses lexical topological order and computes parallel timing", () => {
    const plan = createPlan({
      tasks: [
        { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "docs", duration: 1 },
        { id: "lint", duration: 1 },
      ],
    });

    expect(plan).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 5 },
        deploy: { start: 5, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("chooses the lexicographically smallest full critical path", () => {
    const plan = createPlan({
      tasks: [
        { id: "z", duration: 1, dependsOn: ["a2", "b1"] },
        { id: "a2", duration: 1, dependsOn: ["a1"] },
        { id: "b1", duration: 2 },
        { id: "a1", duration: 1 },
      ],
    });

    expect(plan.totalDuration).toBe(3);
    expect(plan.criticalPath).toEqual(["a1", "a2", "z"]);
  });

  test("compares full paths when one predecessor path is a prefix", () => {
    const plan = createPlan({
      tasks: [
        { id: "a", duration: 1 },
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "z", duration: 1, dependsOn: ["a", "b"] },
      ],
    });

    expect(plan.criticalPath).toEqual(["a", "b", "z"]);
  });

  test("supports no tasks and zero-duration disconnected tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    expect(
      createPlan({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] }),
    ).toMatchObject({
      order: ["a", "b"],
      totalDuration: 0,
      criticalPath: ["a"],
    });
  });

  test("supports ids that are special object property names", () => {
    const plan = createPlan({
      tasks: [
        { id: "__proto__", duration: 1 },
        { id: "constructor", duration: 1, dependsOn: ["__proto__"] },
      ],
    });

    expect(Object.prototype.hasOwnProperty.call(plan.earliest, "__proto__")).toBe(true);
    expect(plan.earliest.__proto__).toEqual({ start: 0, finish: 1 });
    expect(JSON.parse(JSON.stringify(plan)).earliest.__proto__).toEqual({
      start: 0,
      finish: 1,
    });
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      createPlan({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["a"] },
          { id: "b", duration: 1, dependsOn: ["a"] },
          { id: "a", duration: 1, dependsOn: ["b"] },
        ],
      }),
    ).toThrow("dependency cycle: a -> b -> a");
  });
});

describe("validateInput", () => {
  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      "duplicate task id",
    ],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: null }] }, "array of strings"],
    [
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }] },
      "contains duplicate id",
    ],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown task"],
  ])("rejects invalid input %#", (input, message) => {
    expect(() => validateInput(input)).toThrow(message as string);
  });

  test("uses an empty dependency list by default", () => {
    expect(validateInput({ tasks: [{ id: "a", duration: 0 }] })).toEqual([
      { id: "a", duration: 0, dependsOn: [] },
    ]);
  });

  test("uses a dedicated error type", () => {
    expect(() => validateInput(null)).toThrow(InputError);
  });
});
