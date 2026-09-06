import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");
const directories: string[] = [];

async function run(input: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  directories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const child = Bun.spawn([process.execPath, "run", cli, "plan", inputPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("dependency planner", () => {
  test("plans deterministically with concurrency and critical-path ties", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "build"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 4 },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 4 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 3 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("chooses the lexicographically smallest full critical sequence", async () => {
    const result = await run({
      tasks: [
        { id: "z", duration: 1 },
        { id: "a", duration: 1, dependsOn: ["z"] },
        { id: "b", duration: 1 },
        { id: "y", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["b", "y"]);
  });

  test("handles empty input and zero-duration tasks", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });

    const zero = await run({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] });
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
    [{}, "tasks must be an array"],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown dependency"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
  ])("rejects invalid schemas", async (input, message) => {
    const result = await run(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
