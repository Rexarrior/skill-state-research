import { expect, test } from "bun:test";
import { makePlan, parseTasks } from "./cli";

test("plans deterministic parallel work and a lexicographic critical path", () => {
  const plan = makePlan(parseTasks({ tasks: [
    { id: "deploy", duration: 1, dependsOn: ["build", "docs"] },
    { id: "docs", duration: 3 },
    { id: "lint", duration: 1 },
    { id: "build", duration: 2, dependsOn: ["lint"] },
  ] }));
  expect(plan).toEqual({
    order: ["docs", "lint", "build", "deploy"],
    layers: [["docs", "lint"], ["build"], ["deploy"]],
    earliest: { docs: { start: 0, finish: 3 }, lint: { start: 0, finish: 1 }, build: { start: 1, finish: 3 }, deploy: { start: 3, finish: 4 } },
    totalDuration: 4,
    criticalPath: ["docs", "deploy"],
  });
});

test("supports empty and zero-duration inputs", () => {
  expect(makePlan(parseTasks({ tasks: [] }))).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(makePlan(parseTasks({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] }] })).criticalPath).toEqual(["a"]);
});

test("rejects unknown dependencies and reports deterministic cycles", () => {
  expect(() => parseTasks({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] })).toThrow("unknown dependency 'missing'");
  expect(() => makePlan(parseTasks({ tasks: [{ id: "b", duration: 1, dependsOn: ["a"] }, { id: "a", duration: 1, dependsOn: ["b"] }] }))).toThrow("a -> b -> a");
});
