import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function run(input: unknown, ...extraArguments: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));

  const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", inputPath, ...extraArguments], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("dependency planner CLI", () => {
  test("produces deterministic order, layers, timings, and lexicographic critical path", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 3 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 3 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles no tasks and zero-duration chains", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout)).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const zero = await run({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    });
    expect(JSON.parse(zero.stdout).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await run({
      tasks: [
        { id: "c", duration: 1, dependsOn: ["b"] },
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["c"] },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> c -> b -> a");
  });

  test.each([
    [{}, "tasks"],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "non-negative"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "itself"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate"],
  ])("rejects invalid input %#", async (input, message) => {
    const result = await run(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.toLowerCase()).toContain(message);
  });

  test("rejects extra flags", async () => {
    const result = await run({ tasks: [] }, "--verbose");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage");
  });
});
