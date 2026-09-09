import { describe, expect, test } from "bun:test";
import { planDocument } from "../src/cli";

describe("dependency planner", () => {
  test("orders, layers, timings, and a critical path deterministically", () => {
    expect(planDocument({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 2 },
      ],
    })).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        ship: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "ship"],
    });
  });

  test("uses the lexicographically smallest complete critical path", () => {
    const plan = planDocument({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 2, dependsOn: ["z", "a"] },
    ] });
    expect(plan.criticalPath).toEqual(["a", "end"]);
  });

  test("compares full paths when a zero-duration prefix tie exists", () => {
    const plan = planDocument({ tasks: [
      { id: "a", duration: 1 },
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "c", duration: 1, dependsOn: ["a", "b"] },
    ] });
    expect(plan.criticalPath).toEqual(["a", "b", "c"]);
  });

  test("handles empty input and zero-duration dependencies", () => {
    expect(planDocument({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(planDocument({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
    ] }).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planDocument({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("cycle detected: a -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "duplicate id"],
  ] as const)("rejects malformed documents", (input, message) => {
    expect(() => planDocument(input)).toThrow(message);
  });
});
