import { expect, test } from "bun:test";
import { plan } from "../src/cli";

test("plans dependencies, layers, earliest times, and critical path", () => {
  expect(plan({ tasks: [
    { id: "package", duration: 1, dependsOn: ["build", "lint"] },
    { id: "lint", duration: 2 },
    { id: "build", duration: 3, dependsOn: ["compile"] },
    { id: "compile", duration: 4 },
  ] })).toEqual({
    order: ["compile", "build", "lint", "package"],
    layers: [["compile", "lint"], ["build"], ["package"]],
    earliest: { compile: { start: 0, finish: 4 }, build: { start: 4, finish: 7 }, lint: { start: 0, finish: 2 }, package: { start: 7, finish: 8 } },
    totalDuration: 8,
    criticalPath: ["compile", "build", "package"],
  });
});

test("uses lexicographically smallest equal critical path", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 2 }, { id: "a", duration: 2 }, { id: "end", duration: 1, dependsOn: ["z", "a"] },
  ] }).criticalPath).toEqual(["a", "end"]);
});

test("handles no tasks and rejects invalid graphs", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(() => plan({ tasks: [{ id: "a", duration: 1, dependsOn: ["b"] }, { id: "b", duration: 1, dependsOn: ["a"] }] })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
});
