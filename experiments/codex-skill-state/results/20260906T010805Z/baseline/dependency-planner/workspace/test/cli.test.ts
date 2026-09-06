import { describe, expect, test } from "bun:test";
import { createPlan, InputError, validateInput } from "../src/cli";

describe("dependency planner", () => {
  test("prints exactly one JSON object from the CLI", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      "src/cli.ts",
      "plan",
      "test/fixtures/example.json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(new TextDecoder().decode(result.stdout)).toBe(
      '{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":1},"build":{"start":1,"finish":4}},"totalDuration":4,"criticalPath":["lint","build"]}\n',
    );
  });

  test("returns a non-zero exit code for unknown flags", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      "src/cli.ts",
      "plan",
      "test/fixtures/example.json",
      "--verbose",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(new TextDecoder().decode(result.stderr)).toContain('unknown flag "--verbose"');
  });

  test("uses lexical topological order, parallel layers, and earliest timings", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "docs"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "docs", duration: 2 },
        { id: "lint", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "ship"],
      layers: [["docs", "lint"], ["build"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("chooses the lexicographically smallest full critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "z", duration: 2 },
        { id: "a", duration: 1 },
        { id: "c", duration: 2, dependsOn: ["a"] },
        { id: "end", duration: 1, dependsOn: ["z", "c"] },
      ],
    });

    expect(createPlan(tasks).criticalPath).toEqual(["a", "c", "end"]);
  });

  test("handles empty plans, zero durations, and special object keys", () => {
    expect(createPlan(validateInput({ tasks: [] }))).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const plan = createPlan(
      validateInput({
        tasks: [
          { id: "__proto__", duration: 0 },
          { id: "constructor", duration: 0, dependsOn: ["__proto__"] },
        ],
      }),
    );
    const serializedEarliest = JSON.parse(JSON.stringify(plan)).earliest;
    expect(Object.keys(serializedEarliest)).toEqual(["__proto__", "constructor"]);
    expect(serializedEarliest["__proto__"]).toEqual({ start: 0, finish: 0 });
    expect(serializedEarliest.constructor).toEqual({ start: 0, finish: 0 });
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({
      tasks: [
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> b -> a");
  });

  test("rejects malformed task schemas and references", () => {
    const invalidInputs = [
      {},
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: null }] },
    ];

    for (const input of invalidInputs) {
      expect(() => validateInput(input)).toThrow(InputError);
    }
  });
});
