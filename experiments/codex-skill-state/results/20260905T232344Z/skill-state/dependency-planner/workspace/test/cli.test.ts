import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

async function run(input: unknown, ...extraArgs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  directories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  return Bun.spawnSync([process.execPath, "run", "src/cli.ts", "plan", inputPath, ...extraArgs], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("dependency planner CLI", () => {
  test("plans deterministically with parallel layers and a tied critical path", async () => {
    const result = await run({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 3, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 1 },
    ] });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
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

  test("supports empty input and zero-duration tasks", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout.toString())).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });

    const zero = await run({ tasks: [{ id: "b", duration: 0, dependsOn: ["a"] }, { id: "a", duration: 0 }] });
    expect(JSON.parse(zero.stdout.toString()).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await run({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("a -> c -> b -> a");
  });

  test("rejects malformed schemas and extra CLI arguments", async () => {
    const unknown = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr.toString()).toContain("unknown task");

    const flag = await run({ tasks: [] }, "--verbose");
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stderr.toString()).toContain("usage:");
  });
});
