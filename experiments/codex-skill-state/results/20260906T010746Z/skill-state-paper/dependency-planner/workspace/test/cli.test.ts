import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function run(input: unknown) {
  directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(input));
  return Bun.$`bun run src/cli.ts plan ${path}`.quiet().nothrow();
}

describe("dependency planner", () => {
  test("plans deterministically with concurrency and critical path ties", async () => {
    const result = await run({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 3, dependsOn: ["lint"] },
      { id: "build", duration: 3, dependsOn: ["lint"] },
      { id: "lint", duration: 2 },
      { id: "docs", duration: 0 },
    ] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("handles an empty task list", async () => {
    const result = await run({ tasks: [] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await run({ tasks: [
      { id: "c", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["c"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("a -> c -> b -> a");
  });

  test("rejects invalid references and duplicate dependencies", async () => {
    let result = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown task");

    result = await run({ tasks: [
      { id: "a", duration: 1 },
      { id: "b", duration: 1, dependsOn: ["a", "a"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("duplicate id");
  });
});
