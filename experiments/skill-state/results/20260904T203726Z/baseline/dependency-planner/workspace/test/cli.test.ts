import { expect, test } from "bun:test";
import { createPlan, validateInput } from "../src/cli";

test("plans dependencies with lexical ties", () => {
  const plan = createPlan(validateInput({
    tasks: [
      { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 0 },
    ],
  }));

  expect(plan).toEqual({
    order: ["docs", "lint", "build", "test", "deploy"],
    layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
    earliest: {
      docs: { start: 0, finish: 0 },
      lint: { start: 0, finish: 1 },
      build: { start: 1, finish: 4 },
      test: { start: 1, finish: 3 },
      deploy: { start: 4, finish: 5 },
    },
    totalDuration: 5,
    criticalPath: ["lint", "build", "deploy"],
  });
});

test("chooses the lexicographically smallest equal critical path", () => {
  const plan = createPlan(validateInput({
    tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 1, dependsOn: ["z", "a"] },
    ],
  }));
  expect(plan.criticalPath).toEqual(["a", "end"]);
});

test("reports a deterministic cycle", () => {
  expect(() => createPlan(validateInput({
    tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ],
  }))).toThrow("Dependency cycle detected: a -> b -> a");
});

test("rejects invalid task definitions", () => {
  expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
  expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown task");
  expect(() => validateInput({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("own id");
});

test("handles empty task lists", () => {
  expect(createPlan(validateInput({ tasks: [] }))).toEqual({
    order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
  });
});
