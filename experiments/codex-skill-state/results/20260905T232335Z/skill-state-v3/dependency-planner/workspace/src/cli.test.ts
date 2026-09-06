import { describe, expect, test } from "bun:test";
import { planInput, validateInput } from "./cli";

describe("dependency planner", () => {
  test("uses lexical topological order but earliest dependency layers", () => {
    expect(planInput({ tasks: [
      { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 1 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        deploy: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const result = planInput({ tasks: [
      { id: "z", duration: 1, dependsOn: ["a", "b"] },
      { id: "b", duration: 2 },
      { id: "a", duration: 2 },
    ] });
    expect(result.criticalPath).toEqual(["a", "z"]);
    expect(result.totalDuration).toBe(3);
  });

  test("handles empty input and zero-duration paths", () => {
    expect(planInput({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(planInput({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] }).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planInput({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("dependency cycle: a -> b -> a");
  });

  test("rejects malformed tasks and dependencies", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("duplicate task id");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown id");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("cannot depend on itself");
    expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] })).toThrow("duplicate id");
  });
});
