import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function run(input: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  directories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", inputPath], {
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
  test("plans a graph deterministically, including layers, timing, and a tied critical path", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 1 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty plans and zero-duration tasks", async () => {
    expect(JSON.parse((await run({ tasks: [] })).stdout)).toEqual({
      order: [],
      layers: [],
      earliest: {},
      totalDuration: 0,
      criticalPath: [],
    });

    const result = await run({
      tasks: [
        { id: "b", duration: 0, dependsOn: ["a"] },
        { id: "a", duration: 0 },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a"]);
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
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown task"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
    [
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] },
      "duplicate id",
    ],
  ])("rejects invalid input", async (input, message) => {
    const result = await run(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });
});
