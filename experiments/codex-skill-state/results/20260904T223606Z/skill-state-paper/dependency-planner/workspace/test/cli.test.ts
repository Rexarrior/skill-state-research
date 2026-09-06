import { expect, test } from "bun:test";
import { plan } from "../src/cli";

test("plans a graph deterministically", () => {
  expect(plan([
    { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
    { id: "lint", duration: 2, dependsOn: [] },
    { id: "build", duration: 3, dependsOn: ["lint"] },
    { id: "test", duration: 3, dependsOn: ["lint"] },
  ])).toEqual({
    order: ["lint", "build", "test", "deploy"],
    layers: [["lint"], ["build", "test"], ["deploy"]],
    earliest: {
      lint: { start: 0, finish: 2 },
      build: { start: 2, finish: 5 },
      test: { start: 2, finish: 5 },
      deploy: { start: 5, finish: 6 },
    },
    totalDuration: 6,
    criticalPath: ["lint", "build", "deploy"],
  });
});

test("handles empty and zero-duration task graphs", () => {
  expect(plan([])).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(plan([{ id: "b", duration: 0, dependsOn: [] }, { id: "a", duration: 0, dependsOn: [] }]).order).toEqual(["a", "b"]);
});
