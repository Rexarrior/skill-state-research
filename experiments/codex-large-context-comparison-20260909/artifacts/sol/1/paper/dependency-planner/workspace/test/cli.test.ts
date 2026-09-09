import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(input: unknown, extraArgs: string[] = []) {
  const inputPath = join(directory, `${crypto.randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  return Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", "plan", inputPath, ...extraArgs],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdout(result: ReturnType<typeof Bun.spawnSync>): unknown {
  return JSON.parse(result.stdout.toString());
}

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a lexical critical-path tie", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "docs", duration: 2 },
        { id: "lint", duration: 1 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(stdout(result)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
        test: { start: 1, finish: 4 },
        ship: { start: 4, finish: 5 },
      },
      totalDuration: 5,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles empty input and zero-duration tasks", async () => {
    const empty = await run({ tasks: [] });
    expect(stdout(empty)).toEqual({
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
    expect(stdout(zero)).toEqual({
      order: ["a", "b"],
      layers: [["a"], ["b"]],
      earliest: {
        a: { start: 0, finish: 0 },
        b: { start: 0, finish: 0 },
      },
      totalDuration: 0,
      criticalPath: ["a"],
    });
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
    expect(result.stderr.toString()).toContain("a -> c -> b -> a");
  });

  test.each([
    [{}, "'tasks' must be an array"],
    [{ tasks: [{ id: "", duration: 1 }] }, "non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      "unknown id 'missing'",
    ],
    [
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      "cannot depend on itself",
    ],
    [
      {
        tasks: [
          { id: "a", duration: 1 },
          { id: "a", duration: 2 },
        ],
      },
      "duplicate task id 'a'",
    ],
  ])("rejects invalid input", async (input, message) => {
    const result = await run(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(message as string);
    expect(result.stdout.toString()).toBe("");
  });

  test("rejects unknown flags", async () => {
    const result = await run({ tasks: [] }, ["--verbose"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown argument or flag '--verbose'");
  });
});
