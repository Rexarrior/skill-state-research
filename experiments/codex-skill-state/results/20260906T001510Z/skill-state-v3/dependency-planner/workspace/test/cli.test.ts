import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";

const directory = `${import.meta.dir}/fixtures-generated`;
const cli = `${import.meta.dir}/../src/cli.ts`;

beforeAll(() => mkdir(directory, { recursive: true }));
afterAll(() => rm(directory, { recursive: true, force: true }));

async function run(name: string, input: unknown) {
  const file = `${directory}/${name}.json`;
  await writeFile(file, typeof input === "string" ? input : JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", cli, "plan", file], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("dependency planner CLI", () => {
  test("plans deterministic order, layers, timings, and critical path", async () => {
    const result = await run("basic", {
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 4, dependsOn: ["lint"] },
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
        test: { start: 2, finish: 6 },
        ship: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "ship"],
    });
  });

  test("chooses lexicographically smallest full critical path", async () => {
    const result = await run("ties", {
      tasks: [
        { id: "a", duration: 1 },
        { id: "z", duration: 1 },
        { id: "b", duration: 1, dependsOn: ["z"] },
        { id: "c", duration: 1, dependsOn: ["a"] },
        { id: "end", duration: 0, dependsOn: ["b", "c"] },
      ],
    });
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a", "c"]);
  });

  test("supports empty input", async () => {
    const result = await run("empty", { tasks: [] });
    expect(JSON.parse(result.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await run("cycle", {
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

  test.each([
    ["invalid-json", "{"],
    ["duplicate", { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }],
    ["unknown-dependency", { tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }],
    ["self", { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }],
    ["negative", { tasks: [{ id: "a", duration: -1 }] }],
  ])("rejects invalid input: %s", async (name, input) => {
    const result = await run(name as string, input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
