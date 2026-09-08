import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];

test("prints help", async () => {
  const process = Bun.spawn(["bun", "run", cli, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toContain("Usage:");
  expect(await new Response(process.stderr).text()).toBe("");
});

async function run(document: unknown, args: string[] = []): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  temporaryDirectories.push(directory);
  const input = join(directory, "input.json");
  await writeFile(input, JSON.stringify(document));
  const process = Bun.spawn(["bun", "run", cli, "plan", input, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("dependency planner CLI", () => {
  test("plans deterministically with parallel layers and lexicographic tie-breaking", async () => {
    const result = await run({
      tasks: [
        { id: "release", duration: 1, dependsOn: ["build", "docs"] },
        { id: "test", duration: 2, dependsOn: ["lint"] },
        { id: "docs", duration: 3 },
        { id: "build", duration: 2, dependsOn: ["test"] },
        { id: "lint", duration: 1 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "test", "build", "release"],
      layers: [["docs", "lint"], ["test"], ["build"], ["release"]],
      earliest: {
        docs: { start: 0, finish: 3 },
        lint: { start: 0, finish: 1 },
        test: { start: 1, finish: 3 },
        build: { start: 3, finish: 5 },
        release: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "test", "build", "release"],
    });
  });

  test("uses the lexicographically smallest complete critical path", async () => {
    const result = await run({
      tasks: [
        { id: "z", duration: 2 },
        { id: "a", duration: 1 },
        { id: "x", duration: 1, dependsOn: ["a"] },
      ],
    });
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a", "x"]);
  });

  test("supports empty input and zero-duration tasks", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const zero = await run({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] });
    expect(JSON.parse(zero.stdout).criticalPath).toEqual(["a"]);
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
    expect(result.stderr).toContain("a -> b -> c -> a");
  });

  test("rejects malformed schemas", async () => {
    const cases = [
      {},
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] },
    ];
    for (const document of cases) {
      const result = await run(document);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("Error:");
    }
  });

  test("rejects unknown flags", async () => {
    const result = await run({ tasks: [] }, ["--verbose"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown flag");
  });
});
