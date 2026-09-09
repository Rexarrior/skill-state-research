import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("uses lexical topological order and unlimited-parallel timings", () => {
    const plan = createPlan(validateInput({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 1 },
    ] }));

    expect(plan).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        ship: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "ship"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const plan = createPlan(validateInput({ tasks: [
      { id: "z", duration: 2 },
      { id: "a", duration: 2 },
      { id: "end", duration: 1, dependsOn: ["z", "a"] },
    ] }));
    expect(plan.criticalPath).toEqual(["a", "end"]);
  });

  test("uses locale-independent lexical ordering", () => {
    const plan = createPlan(validateInput({ tasks: [
      { id: "a", duration: 1 },
      { id: "A", duration: 1 },
    ] }));
    expect(plan.order).toEqual(["A", "a"]);
    expect(plan.layers).toEqual([["A", "a"]]);
    expect(plan.criticalPath).toEqual(["A"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const zero = createPlan(validateInput({ tasks: [
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
    ] }));
    expect(zero.totalDuration).toBe(0);
    expect(zero.criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });

  test.each([
    [{}, '\"tasks\" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown dependency"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "duplicate id"],
  ])("rejects invalid schema %#", (input, message) => {
    expect(() => validateInput(input)).toThrow(message as string);
  });
});
