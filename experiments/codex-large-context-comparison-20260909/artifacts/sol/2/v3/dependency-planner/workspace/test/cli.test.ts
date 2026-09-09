import { describe, expect, test } from "bun:test";
import { createPlan, main, parseInput } from "../src/cli";

describe("dependency planner", () => {
  test("plans deterministically with parallel branches and a lexical path tie", () => {
    const tasks = parseInput({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["test", "build"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
      { id: "docs", duration: 1 },
    ] });
    expect(createPlan(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createPlan(parseInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan(parseInput({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
    ] })).totalDuration).toBe(0);
  });

  test.each([
    [{}, /tasks.*array/],
    [{ tasks: [{ id: "", duration: 1 }] }, /non-empty/],
    [{ tasks: [{ id: "a", duration: Number.NaN }] }, /finite non-negative/],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, /unknown dependency/],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, /cannot depend on itself/],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["x", "x"] }] }, /duplicate "x"/],
  ])("rejects invalid input", (input, pattern) => {
    expect(() => parseInput(input)).toThrow(pattern as RegExp);
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = parseInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["a"] },
      { id: "b", duration: 1, dependsOn: ["c"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(() => createPlan(tasks)).toThrow("Dependency cycle: a -> b -> c -> a");
  });

  test("rejects flags in command and input positions", async () => {
    await expect(main(["--help"])).rejects.toThrow("Unknown flag: --help");
    await expect(main(["plan", "--input"])).rejects.toThrow("Unknown flag: --input");
  });

  test("CLI prints exactly one JSON object", async () => {
    const process = Bun.spawn({
      cmd: [Bun.argv[0], "run", "src/cli.ts", "plan", "test/fixtures/basic.json"],
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(
      '{"order":["lint","build"],"layers":[["lint"],["build"]],"earliest":{"lint":{"start":0,"finish":1},"build":{"start":1,"finish":4}},"totalDuration":4,"criticalPath":["lint","build"]}\n',
    );
  });

  test("CLI failures use stderr and a non-zero status", async () => {
    const process = Bun.spawn({
      cmd: [Bun.argv[0], "run", "src/cli.ts", "unknown"],
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown command: unknown");
  });
});
