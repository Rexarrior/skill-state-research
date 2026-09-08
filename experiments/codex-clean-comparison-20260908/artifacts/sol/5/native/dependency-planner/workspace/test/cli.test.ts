import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function run(input: unknown, ...extraArgs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  directories.push(directory);
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(input));
  return Bun.$`bun run src/cli.ts plan ${path} ${extraArgs}`.quiet().nothrow();
}

describe("dependency planner CLI", () => {
  test("plans a graph deterministically", async () => {
    const result = await run({
      tasks: [
        { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 2 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        build: { start: 2, finish: 5 },
        deploy: { start: 6, finish: 7 },
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 2 },
        test: { start: 2, finish: 6 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("uses the lexicographically smallest complete critical path", async () => {
    const result = await run({
      tasks: [
        { id: "z", duration: 1 },
        { id: "a", duration: 1 },
        { id: "end", duration: 0, dependsOn: ["z", "a"] },
      ],
    });
    // Both ["a"] and ["a", "end"] total 1; the shorter prefix sorts first.
    expect(JSON.parse(result.stdout.toString()).criticalPath).toEqual(["a"]);
  });

  test("handles empty and zero-duration plans", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout.toString())).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });

    const zero = await run({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] });
    expect(JSON.parse(zero.stdout.toString()).criticalPath).toEqual(["a"]);
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
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("a -> b -> c -> a");
  });

  test("rejects invalid schemas", async () => {
    const cases = [
      {},
      { tasks: [{ id: "", duration: 1 }] },
      { tasks: [{ id: "a", duration: -1 }] },
      { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] },
      { tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] },
    ];
    for (const input of cases) {
      const result = await run(input);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toStartWith("error:");
    }
  });

  test("rejects malformed JSON and unsupported arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
    directories.push(directory);
    const path = join(directory, "bad.json");
    await writeFile(path, "{");

    const malformed = await Bun.$`bun run src/cli.ts plan ${path}`.quiet().nothrow();
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout.toString()).toBe("");
    expect(malformed.stderr.toString()).toContain("invalid JSON");

    const unknown = await Bun.$`bun run src/cli.ts plan ${path} --wat`.quiet().nothrow();
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stdout.toString()).toBe("");
    expect(unknown.stderr.toString()).toContain("unknown option: --wat");
  });
});
