import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSchedule, CycleError, InputError } from "./cli";

describe("createSchedule", () => {
  test("plans a graph deterministically with parallel layers", () => {
    expect(
      createSchedule({
        tasks: [
          { id: "ship", duration: 1, dependsOn: ["build", "test"] },
          { id: "test", duration: 2, dependsOn: ["lint"] },
          { id: "build", duration: 3, dependsOn: ["lint"] },
          { id: "lint", duration: 1 },
          { id: "docs", duration: 2 },
        ],
      }),
    ).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        build: { start: 1, finish: 4 },
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        ship: { start: 4, finish: 5 },
        test: { start: 1, finish: 3 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("uses the lexicographically smallest full critical path on ties", () => {
    const result = createSchedule({
      tasks: [
        { id: "c", duration: 1, dependsOn: ["a", "b"] },
        { id: "a", duration: 1 },
        { id: "b", duration: 1 },
      ],
    });
    expect(result.criticalPath).toEqual(["a", "c"]);
  });

  test("compares full paths, including zero-duration dependency chains", () => {
    const result = createSchedule({
      tasks: [
        { id: "a", duration: 1 },
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "c", duration: 1, dependsOn: ["a", "b"] },
      ],
    });
    expect(result.criticalPath).toEqual(["a", "b", "c"]);
  });

  test("supports empty input and zero-duration tasks", () => {
    expect(createSchedule({ tasks: [] })).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });
    expect(
      createSchedule({ tasks: [{ id: "zero", duration: 0 }] }).criticalPath,
    ).toEqual(["zero"]);
  });

  test("reports a deterministic concrete cycle", () => {
    expect(() =>
      createSchedule({
        tasks: [
          { id: "c", duration: 1, dependsOn: ["b"] },
          { id: "b", duration: 1, dependsOn: ["c"] },
          { id: "a", duration: 1, dependsOn: ["b"] },
        ],
      }),
    ).toThrow(new CycleError(["b", "c", "b"]));
  });

  test("rejects invalid schemas", () => {
    expect(() => createSchedule({ tasks: "no" })).toThrow(InputError);
    expect(() =>
      createSchedule({
        tasks: [
          { id: "a", duration: 1 },
          { id: "a", duration: 2 },
        ],
      }),
    ).toThrow("duplicate task id");
    expect(() =>
      createSchedule({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }),
    ).toThrow("unknown task");
  });
});

async function invokeCli(...args: string[]) {
  const subprocess = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "cli.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI", () => {
  test("prints exactly one JSON schedule", async () => {
    const input = join(import.meta.dir, "../test/fixtures/simple.json");
    const result = await invokeCli("plan", input);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["lint", "build"],
      layers: [["lint"], ["build"]],
      earliest: {
        build: { start: 1, finish: 4 },
        lint: { start: 0, finish: 1 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build"],
    });
  });

  test("fails with a concrete cycle on stderr", async () => {
    const input = join(import.meta.dir, "../test/fixtures/cycle.json");
    const result = await invokeCli("plan", input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> b -> a");
  });

  test("rejects unknown flags", async () => {
    const result = await invokeCli("plan", "--verbose");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown flag: --verbose");
  });
});
