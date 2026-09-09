import { afterEach, describe, expect, test } from "bun:test";
import { planTasks, validateInput } from "./cli";

const temporaryFiles: string[] = [];

afterEach(async () => {
  for (const path of temporaryFiles.splice(0)) await Bun.file(path).delete();
});

describe("dependency planning", () => {
  test("plans deterministically with layers, timing, and a critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 2 },
      ],
    });

    expect(planTasks(tasks)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 3 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("chooses the lexicographically smallest complete critical path", () => {
    const tasks = validateInput({
      tasks: [
        { id: "z", duration: 1, dependsOn: ["b", "x"] },
        { id: "b", duration: 2, dependsOn: ["a"] },
        { id: "x", duration: 2, dependsOn: ["a"] },
        { id: "a", duration: 1 },
      ],
    });
    expect(planTasks(tasks).criticalPath).toEqual(["a", "b", "z"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(planTasks(validateInput({ tasks: [] }))).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const result = planTasks(validateInput({ tasks: [
      { id: "a", duration: 0 },
      { id: "b", duration: 0, dependsOn: ["a"] },
    ] }));
    expect(result.totalDuration).toBe(0);
    expect(result.criticalPath).toEqual(["a"]);
  });

  test("rejects invalid schema", () => {
    expect(() => validateInput({ tasks: [{ id: "a", duration: -1 }] })).toThrow("finite non-negative");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1, dependsOn: ["missing"] },
    ] })).toThrow("unknown id");
    expect(() => validateInput({ tasks: [
      { id: "a", duration: 1 }, { id: "a", duration: 2 },
    ] })).toThrow("duplicate task id");
  });

  test("reports a deterministic concrete cycle", () => {
    const tasks = validateInput({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(() => planTasks(tasks)).toThrow("a -> c -> b -> a");
  });
});

describe("CLI", () => {
  test("prints exactly one JSON object", async () => {
    const path = `${process.cwd()}/.cli-test-${process.pid}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));
    const processResult = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path], {
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      order: ["build"], layers: [["build"]],
      earliest: { build: { start: 0, finish: 3 } },
      totalDuration: 3, criticalPath: ["build"],
    });
  });

  test("fails non-zero for invalid JSON and unknown flags", async () => {
    const path = `${process.cwd()}/.cli-bad-${process.pid}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, "not json");
    const invalid = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path], { stderr: "pipe" });
    expect(await invalid.exited).not.toBe(0);
    expect(await new Response(invalid.stderr).text()).toContain("invalid JSON");

    const flagged = Bun.spawn(["bun", "run", "src/cli.ts", "plan", "--wat"], { stderr: "pipe" });
    expect(await flagged.exited).not.toBe(0);
    expect(await new Response(flagged.stderr).text()).toContain("unknown flag");
  });
});
