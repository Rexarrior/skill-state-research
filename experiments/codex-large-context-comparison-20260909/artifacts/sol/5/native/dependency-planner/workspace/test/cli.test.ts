import { describe, expect, test } from "bun:test";
import { planInput } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel work and defaults", () => {
    expect(planInput({
      tasks: [
        { id: "deploy", duration: 2, dependsOn: ["package", "test"] },
        { id: "test", duration: 4, dependsOn: ["compile"] },
        { id: "lint", duration: 1 },
        { id: "package", duration: 1, dependsOn: ["compile"] },
        { id: "compile", duration: 3, dependsOn: ["lint"] },
      ],
    })).toEqual({
      order: ["lint", "compile", "package", "test", "deploy"],
      layers: [["lint"], ["compile"], ["package", "test"], ["deploy"]],
      earliest: {
        compile: { start: 1, finish: 4 },
        deploy: { start: 8, finish: 10 },
        lint: { start: 0, finish: 1 },
        package: { start: 4, finish: 5 },
        test: { start: 4, finish: 8 },
      },
      totalDuration: 10,
      criticalPath: ["lint", "compile", "test", "deploy"],
    });
  });

  test("uses the lexicographically smallest full critical path", () => {
    expect(planInput({
      tasks: [
        { id: "z", duration: 1 },
        { id: "a", duration: 1 },
        { id: "end", duration: 2, dependsOn: ["z", "a"] },
        { id: "other", duration: 3 },
      ],
    }).criticalPath).toEqual(["a", "end"]);
  });

  test("supports empty graphs and zero-duration tasks", () => {
    expect(planInput({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(planInput({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    }).criticalPath).toEqual(["a"]);

    expect(planInput({
      tasks: [
        { id: "z", duration: 0 },
        { id: "a", duration: 2, dependsOn: ["z"] },
      ],
    }).criticalPath).toEqual(["a"]);
  });

  test.each([
    [{}, "tasks"],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "non-negative"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "duplicate id"],
  ])("rejects malformed input", (input, message) => {
    expect(() => planInput(input)).toThrow(message as string);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => planInput({
      tasks: [
        { id: "z", duration: 1, dependsOn: ["b"] },
        { id: "b", duration: 1, dependsOn: ["z"] },
      ],
    })).toThrow("b -> z -> b");
  });

  test("CLI prints only JSON on success and fails cleanly for bad commands", () => {
    const projectDirectory = new URL("..", import.meta.url).pathname;
    const success = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli.ts", "plan", "test/fixture.json"],
      cwd: projectDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(JSON.parse(success.stdout.toString())).toEqual({
      order: ["first", "second"],
      layers: [["first"], ["second"]],
      earliest: {
        first: { start: 0, finish: 2 },
        second: { start: 2, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["first", "second"],
    });

    const failure = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli.ts", "unknown"],
      cwd: projectDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failure.exitCode).not.toBe(0);
    expect(failure.stdout.toString()).toBe("");
    expect(failure.stderr.toString()).toContain("unknown command");
  });
});
