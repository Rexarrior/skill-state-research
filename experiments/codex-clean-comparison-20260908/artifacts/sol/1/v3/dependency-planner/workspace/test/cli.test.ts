import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const cli = join(projectRoot, "src", "cli.ts");
const temporaryDirectories: string[] = [];

async function run(args: string[], input: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
  temporaryDirectories.push(directory);
  const inputPath = join(directory, "input.json");
  await writeFile(inputPath, typeof input === "string" ? input : JSON.stringify(input));

  const process = Bun.spawn(["bun", "run", cli, ...args, inputPath], {
    cwd: projectRoot,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("dependency planner CLI", () => {
  test("plans dependencies deterministically with parallel layers", async () => {
    const result = await run(["plan"], {
      tasks: [
        { id: "test", duration: 4, dependsOn: ["lint"] },
        { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 1 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "deploy"],
      layers: [["docs", "lint"], ["build", "test"], ["deploy"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 6 },
        deploy: { start: 6, finish: 7 },
      },
      totalDuration: 7,
      criticalPath: ["lint", "test", "deploy"],
    });
  });

  test("uses the lexicographically smallest full critical path", async () => {
    const result = await run(["plan"], {
      tasks: [
        { id: "z", duration: 1 },
        { id: "a", duration: 1 },
        { id: "end", duration: 1, dependsOn: ["z", "a"] },
        { id: "b", duration: 1 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a", "end"]);
  });

  test("handles an empty task list", async () => {
    const result = await run(["plan"], { tasks: [] });
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
    const result = await run(["plan"], {
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
    ["invalid JSON", "{", "invalid JSON"],
    ["missing tasks", {}, '"tasks" must be an array'],
    ["duplicate ids", { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    ["unknown dependency", { tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] }, "unknown dependency"],
    ["self dependency", { tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
  ])("rejects %s", async (_name, input, message) => {
    const result = await run(["plan"], input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  test("rejects unknown flags", async () => {
    const result = await run(["plan", "--verbose"], { tasks: [] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
});
