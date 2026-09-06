import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");
const temporaryDirectories: string[] = [];

async function run(input: unknown, ...extraArguments: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-test-"));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));

  const process = Bun.spawn(["bun", "run", cli, "plan", inputPath, ...extraArguments], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("dependency planner CLI", () => {
  test("produces deterministic order, layers, timings, and a tied critical path", async () => {
    const result = await run({
      tasks: [
        { id: "finish", duration: 1, dependsOn: ["right", "left"] },
        { id: "right", duration: 2 },
        { id: "left", duration: 2 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["left", "right", "finish"],
      layers: [["left", "right"], ["finish"]],
      earliest: {
        left: { start: 0, finish: 2 },
        right: { start: 0, finish: 2 },
        finish: { start: 2, finish: 3 },
      },
      totalDuration: 3,
      criticalPath: ["left", "finish"],
    });
  });

  test("chooses a concrete lexicographically smallest path when every duration is zero", async () => {
    const result = await run({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a"]);
  });

  test("reports an empty plan for an empty task list", async () => {
    const result = await run({ tasks: [] });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });
  });

  test("fails with a deterministic concrete cycle", async () => {
    const result = await run({
      tasks: [
        { id: "c", duration: 1, dependsOn: ["a"] },
        { id: "b", duration: 1, dependsOn: ["c"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> b -> c -> a");
  });

  test("rejects invalid dependencies and extra flags", async () => {
    const invalidDependency = await run({
      tasks: [{ id: "build", duration: 1, dependsOn: ["missing"] }],
    });
    expect(invalidDependency.exitCode).not.toBe(0);
    expect(invalidDependency.stderr).toContain("unknown task: missing");

    const extraFlag = await run({ tasks: [] }, "--verbose");
    expect(extraFlag.exitCode).not.toBe(0);
    expect(extraFlag.stderr).toContain("usage:");
  });
});
