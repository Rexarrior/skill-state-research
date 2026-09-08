import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];

async function invoke(input: unknown, ...extraArguments: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("dependency planner CLI", () => {
  test("plans deterministically with parallel layers and critical-path ties", async () => {
    const result = await invoke({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["test", "bundle"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "bundle", duration: 2, dependsOn: ["build"] },
        { id: "lint", duration: 1 },
        { id: "build", duration: 1 },
        { id: "docs", duration: 0 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["build", "bundle", "docs", "lint", "test", "ship"],
      layers: [["build", "docs", "lint"], ["bundle", "test"], ["ship"]],
      earliest: {
        build: { start: 0, finish: 1 },
        bundle: { start: 1, finish: 3 },
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 1 },
        ship: { start: 3, finish: 4 },
        test: { start: 1, finish: 3 },
      },
      totalDuration: 4,
      criticalPath: ["build", "bundle", "ship"],
    });
  });

  test("handles an empty task list", async () => {
    const result = await invoke({ tasks: [] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "", duration: 1 }] }, "id must be a non-empty string"],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative number"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown task missing"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id: a"],
  ])("rejects invalid input %#", async (input, message) => {
    const result = await invoke(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message as string);
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await invoke({ tasks: [
      { id: "c", duration: 1, dependsOn: ["a"] },
      { id: "b", duration: 1, dependsOn: ["c"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dependency cycle: a -> b -> c -> a");
  });

  test("rejects unknown flags", async () => {
    const result = await invoke({ tasks: [] }, "--verbose");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown flag: --verbose");
  });
});
