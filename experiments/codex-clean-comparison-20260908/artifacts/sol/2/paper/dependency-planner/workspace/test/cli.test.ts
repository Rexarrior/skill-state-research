import { describe, expect, test } from "bun:test";
import { plan } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel work", () => {
    expect(plan({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 4, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 2 },
    ] })).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 5 },
        deploy: { start: 5, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("handles empty input and zero-duration tie breaking", () => {
    expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(plan({ tasks: [
      { id: "z", duration: 0, dependsOn: ["a", "b"] },
      { id: "b", duration: 0 },
      { id: "a", duration: 0 },
    ] }).criticalPath).toEqual(["a"]);
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    expect(plan({ tasks: [
      { id: "z", duration: 1, dependsOn: ["x", "b"] },
      { id: "x", duration: 0, dependsOn: ["a"] },
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 1 },
    ] }).criticalPath).toEqual(["a", "b", "z"]);
  });

  test("rejects malformed task data", () => {
    expect(() => plan({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => plan({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("duplicate task id");
    expect(() => plan({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown dependency");
    expect(() => plan({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("cannot depend on itself");
  });

  test("reports a deterministic cycle", () => {
    expect(() => plan({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] })).toThrow("a -> c -> b -> a");
  });
});

