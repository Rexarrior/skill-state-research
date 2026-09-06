import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("plans deterministic order, layers, times, and tied critical paths", () => {
    const tasks = validateInput({ tasks: [
      { id: "release", duration: 1, dependsOn: ["test", "build"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 1 },
    ] });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "release"],
      layers: [["docs", "lint"], ["build", "test"], ["release"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        release: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "release"],
    });
  });

  test("handles empty input and zero-duration tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(validateInput({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
    ] })).criticalPath).toEqual(["a", "b"]);
  });

  test("allows ids that are special Object property names", () => {
    const plan = createPlan(validateInput({ tasks: [
      { id: "__proto__", duration: 1 },
      { id: "constructor", duration: 2, dependsOn: ["__proto__"] },
    ] }));
    expect(plan.earliest["__proto__"]).toEqual({ start: 0, finish: 1 });
    expect(plan.totalDuration).toBe(3);
  });

  test("rejects invalid schemas", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: null }] })).toThrow("must be an array");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown dependency");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
  });

  test("reports a deterministic cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> c -> b -> a");
  });
});
