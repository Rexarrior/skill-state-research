import { describe, expect, test } from "bun:test";
import { createPlan } from "./cli";

describe("dependency planner", () => {
  test("plans parallel tasks deterministically", () => {
    expect(createPlan({ tasks: [
      { id: "deploy", duration: 2, dependsOn: ["build", "test"] },
      { id: "test", duration: 5, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] })).toEqual({
      order: ["lint", "build", "test", "deploy"],
      layers: [["lint"], ["build", "test"], ["deploy"]],
      earliest: {
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 6 },
        deploy: { start: 6, finish: 8 },
      },
      totalDuration: 8,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("uses the lexicographically smallest complete tied path", () => {
    expect(createPlan({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 2, dependsOn: ["z", "a"] },
    ] }).criticalPath).toEqual(["a", "end"]);

    expect(createPlan({ tasks: [
      { id: "a", duration: 0 },
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "zz", duration: 1, dependsOn: ["a", "z"] },
    ] }).criticalPath).toEqual(["a", "z", "zz"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] }))
      .toMatchObject({ totalDuration: 0, criticalPath: ["a"] });
  });

  test("accepts task IDs that are special object property names", () => {
    const plan = createPlan({ tasks: [
      { id: "__proto__", duration: 2 },
      { id: "constructor", duration: 1, dependsOn: ["__proto__"] },
    ] });
    expect(JSON.parse(JSON.stringify(plan.earliest))).toEqual({
      ["__proto__"]: { start: 0, finish: 2 },
      constructor: { start: 2, finish: 3 },
    });
  });

  test("rejects invalid graphs", () => {
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("duplicate");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }, { id: "b", duration: 1, dependsOn: ["a"] }] }))
      .toThrow("a -> b -> a");
  });
});
