import { describe, expect, test } from "bun:test";
import { createPlan, parseTasks } from "../src/cli";

describe("dependency planner", () => {
  test("CLI emits only the plan JSON on stdout", async () => {
    const subprocess = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "plan", "/dev/stdin"],
      {
        stdin: new Blob(['{"tasks":[{"id":"a","duration":2}]}']),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      order: ["a"],
      layers: [["a"]],
      earliest: { a: { start: 0, finish: 2 } },
      totalDuration: 2,
      criticalPath: ["a"],
    });
  });

  test("CLI failures use stderr and a non-zero status", async () => {
    const subprocess = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "plan", "--unknown"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown flag: --unknown");
  });

  test("plans deterministically with parallel work and tie-breaking", () => {
    const tasks = parseTasks({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "lint", duration: 2 },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "docs", duration: 1 },
      ],
    });

    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        build: { start: 2, finish: 5 },
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        ship: { start: 5, finish: 6 },
        test: { start: 2, finish: 5 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty input and zero-duration disconnected tasks", () => {
    expect(createPlan(parseTasks({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(parseTasks({ tasks: [
      { id: "z", duration: 0 },
      { id: "a", duration: 0 },
    ] }))).toMatchObject({
      order: ["a", "z"], totalDuration: 0, criticalPath: ["a"],
    });
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = parseTasks({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("dependency cycle: a -> c -> b -> a");
  });

  test("compares the complete critical path when zero-duration paths tie", () => {
    const tasks = parseTasks({ tasks: [
      { id: "a", duration: 1 },
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "zz", duration: 1, dependsOn: ["a", "z"] },
    ] });
    expect(createPlan(tasks).criticalPath).toEqual(["a", "z", "zz"]);
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x", "x"] }] }, "duplicate id"],
  ])("rejects invalid input", (input, message) => {
    expect(() => parseTasks(input)).toThrow(message as string);
  });
});
