import { describe, expect, test } from "bun:test";
import { createPlan, validateInput } from "./cli";

describe("dependency planner", () => {
  test("prints exactly one JSON result when invoked as a CLI", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", `${import.meta.dir}/cli.ts`, "plan", `${import.meta.dir}/../test/fixtures/basic.json`],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const stdout = result.stdout.toString();
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      order: ["docs", "lint", "build"],
      layers: [["docs", "lint"], ["build"]],
      earliest: {
        build: { start: 1, finish: 4 },
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 1 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build"],
    });
  });

  test("plans deterministic order, layers, times, and the lexical critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        build: { start: 1, finish: 3 },
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        ship: { start: 3, finish: 4 },
        test: { start: 1, finish: 3 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty plans, disconnected tasks, and zero durations", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const plan = createPlan(validateInput({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "z", duration: 2 },
        { id: "a", duration: 0 },
      ],
    }));
    expect(plan.order).toEqual(["a", "b", "z"]);
    expect(plan.layers).toEqual([["a", "z"], ["b"]]);
    expect(plan.totalDuration).toBe(2);
    expect(plan.criticalPath).toEqual(["z"]);
  });

  test("rejects invalid schemas and reports a deterministic cycle", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1, dependsOn: ["missing"] },
    ] })).toThrow("unknown dependency");

    const cyclic = validateInput({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createPlan(cyclic)).toThrow("a -> b -> a");
  });

  test("fails unknown CLI commands without writing JSON to stdout", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", `${import.meta.dir}/cli.ts`, "unknown"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("unknown command");
  });

  test("handles ids that are special object property names", () => {
    const plan = createPlan(validateInput({ tasks: [{ id: "__proto__", duration: 1 }] }));
    expect(JSON.parse(JSON.stringify(plan)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  });
});
