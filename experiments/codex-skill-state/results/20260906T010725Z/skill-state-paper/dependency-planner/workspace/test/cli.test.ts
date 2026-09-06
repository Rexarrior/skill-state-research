import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const temporaryDirectory = join(import.meta.dir, ".tmp");
await mkdir(temporaryDirectory, { recursive: true });

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function run(input: unknown) {
  const inputPath = join(temporaryDirectory, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/cli.ts"), "plan", inputPath], {
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

describe("dependency planner", () => {
  test("plans deterministically with parallel layers and a lexical critical-path tie break", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "build", duration: 2, dependsOn: ["lint"] },
        { id: "lint", duration: 1 },
        { id: "docs", duration: 0 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles an empty task list", async () => {
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

  test("reports a deterministic concrete cycle", async () => {
    const result = await run({
      tasks: [
        { id: "c", duration: 1, dependsOn: ["a"] },
        { id: "b", duration: 1, dependsOn: ["c"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dependency cycle: a -> b -> c -> a");
  });

  test("rejects invalid dependencies", async () => {
    const duplicate = await run({
      tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }],
    });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate id: b");

    const unknown = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("unknown task: missing");
  });
});
