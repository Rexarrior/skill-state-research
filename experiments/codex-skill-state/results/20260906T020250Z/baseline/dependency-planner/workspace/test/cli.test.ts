import { afterEach, describe, expect, test } from "bun:test";
import { createPlan } from "../src/cli";

const temporaryFiles: string[] = [];

afterEach(async () => {
  for (const path of temporaryFiles.splice(0)) await Bun.file(path).delete();
});

describe("createPlan", () => {
  test("plans deterministic order, layers, times, and critical path", () => {
    expect(createPlan({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "docs"] },
        { id: "test", duration: 2, dependsOn: ["build"] },
        { id: "docs", duration: 2 },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
      ],
    })).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build"], ["test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 4, finish: 6 },
        ship: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "build", "test", "ship"],
    });
  });

  test("uses the lexicographically smallest complete critical path on ties", () => {
    const result = createPlan({ tasks: [
      { id: "z", duration: 1 },
      { id: "a", duration: 1 },
      { id: "end", duration: 2, dependsOn: ["z", "a"] },
    ] });
    expect(result.criticalPath).toEqual(["a", "end"]);
  });

  test("supports task ids that are special object property names", () => {
    const result = createPlan({ tasks: [
      { id: "__proto__", duration: 1 },
      { id: "constructor", duration: 2, dependsOn: ["__proto__"] },
    ] });
    expect(result.earliest["__proto__"]).toEqual({ start: 0, finish: 1 });
    expect(result.earliest.constructor).toEqual({ start: 1, finish: 3 });
    expect(JSON.parse(JSON.stringify(result)).earliest["__proto__"]).toEqual({ start: 0, finish: 1 });
  });

  test("supports empty input, disconnected tasks, and zero durations", () => {
    expect(createPlan({ tasks: [] })).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    expect(createPlan({ tasks: [
      { id: "b", duration: 0, dependsOn: ["a"] },
      { id: "a", duration: 0 },
      { id: "x", duration: 0 },
    ] })).toMatchObject({
      order: ["a", "b", "x"],
      layers: [["a", "x"], ["b"]],
      totalDuration: 0,
      criticalPath: ["a"],
    });
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] }, "duplicate id"],
  ] as const)("rejects invalid input %#", (input, message) => {
    expect(() => createPlan(input)).toThrow(message);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() => createPlan({ tasks: [
      { id: "c", duration: 1, dependsOn: ["a"] },
      { id: "b", duration: 1, dependsOn: ["c"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] })).toThrow("a -> b -> c -> a");
  });
});

describe("CLI", () => {
  test("prints exactly one JSON object", async () => {
    const path = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));
    const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(stdout)).toMatchObject({ order: ["build"], totalDuration: 3 });
  });

  test("fails non-zero for bad JSON and unknown flags", async () => {
    const path = `${import.meta.dir}/bad-${crypto.randomUUID()}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, "{");

    const badJson = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
    });
    expect(await badJson.exited).not.toBe(0);
    expect(await new Response(badJson.stderr).text()).toContain("invalid JSON");

    const badFlag = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path, "--verbose"], {
      cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe",
    });
    expect(await badFlag.exited).not.toBe(0);
    expect(await new Response(badFlag.stderr).text()).toContain('unknown flag "--verbose"');
  });
});
