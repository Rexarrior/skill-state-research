import { describe, expect, test } from "bun:test";
import { InputError, plan, validateInput } from "./cli";

describe("dependency planning", () => {
  test("plans a graph deterministically", () => {
    expect(
      plan({
        tasks: [
          { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
          { id: "test", duration: 4, dependsOn: ["lint"] },
          { id: "build", duration: 3, dependsOn: ["lint"] },
          { id: "lint", duration: 2 },
        ],
      }),
    ).toEqual({
      order: ["lint", "build", "test", "deploy"],
      layers: [["lint"], ["build", "test"], ["deploy"]],
      earliest: {
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        deploy: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("uses the lexicographically smallest full critical path", () => {
    const result = plan({
      tasks: [
        { id: "z", duration: 1, dependsOn: ["a", "b"] },
        { id: "a", duration: 2 },
        { id: "b", duration: 2 },
      ],
    });
    expect(result.criticalPath).toEqual(["a", "z"]);
    expect(result.totalDuration).toBe(3);
  });

  test("handles empty input and zero-duration disconnected tasks", () => {
    expect(plan({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    expect(
      plan({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] }),
    ).toMatchObject({
      order: ["a", "b"],
      layers: [["a", "b"]],
      totalDuration: 0,
      criticalPath: ["a"],
    });
  });

  test("supports ids that are Object prototype property names", () => {
    const result = plan({
      tasks: [
        { id: "constructor", duration: 1, dependsOn: ["__proto__"] },
        { id: "__proto__", duration: 2 },
      ],
    });
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized.order).toEqual(["__proto__", "constructor"]);
    expect(serialized.earliest["__proto__"]).toEqual({ start: 0, finish: 2 });
    expect(serialized.earliest.constructor).toEqual({ start: 2, finish: 3 });
    expect(serialized.totalDuration).toBe(3);
  });

  test("rejects schema errors", () => {
    const invalidInputs = [
      null,
      {},
      { tasks: "no" },
      { tasks: [null] },
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: "b" }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ];
    for (const input of invalidInputs) expect(() => validateInput(input)).toThrow(InputError);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      plan({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["a"] },
          { id: "b", duration: 1, dependsOn: ["c"] },
          { id: "a", duration: 1, dependsOn: ["b"] },
        ],
      }),
    ).toThrow("dependency cycle: a -> b -> c -> a");
  });
});
