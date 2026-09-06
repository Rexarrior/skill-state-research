import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan } from "../src/cli";

describe("createPlan", () => {
  test("plans deterministically with parallel layers and earliest times", () => {
    expect(createPlan({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 1 },
      ],
    })).toEqual({
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

  test("uses the lexicographically smallest complete critical path on ties", () => {
    const plan = createPlan({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 2, dependsOn: ["z", "a"] },
    ] });
    expect(plan.totalDuration).toBe(3);
    expect(plan.criticalPath).toEqual(["a", "end"]);
  });

  test("supports empty plans, disconnected tasks, and zero durations", () => {
    expect(createPlan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
    expect(createPlan({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] }).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => createPlan({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("Cycle detected: a -> b -> a");
  });

  test("validates task schema and dependency references", () => {
    expect(() => createPlan({})).toThrow('"tasks" must be an array');
    expect(() => createPlan({ tasks: [{ id: "", duration: 1 }] })).toThrow("non-empty string");
    expect(() => createPlan({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] })).toThrow("Duplicate task id");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] })).toThrow("unknown task");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] })).toThrow("cannot depend on itself");
    expect(() => createPlan({ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] })).toThrow("duplicate dependency");
  });
});

const directory = mkdtempSync(join(tmpdir(), "dependency-planner-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("CLI", () => {
  test("prints exactly one JSON object", () => {
    const input = join(directory, "input.json");
    writeFileSync(input, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));
    const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "plan", input], { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(stdout).totalDuration).toBe(3);
  });

  test("rejects malformed JSON and unknown flags on stderr", () => {
    const input = join(directory, "bad.json");
    writeFileSync(input, "{");
    const malformed = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "plan", input], { cwd: process.cwd() });
    expect(malformed.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(malformed.stderr)).toContain("Invalid JSON");

    const flag = Bun.spawnSync([process.execPath, "run", "src/cli.ts", "plan", input, "--wat"], { cwd: process.cwd() });
    expect(flag.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(flag.stderr)).toContain("Unknown flag: --wat");
  });
});
