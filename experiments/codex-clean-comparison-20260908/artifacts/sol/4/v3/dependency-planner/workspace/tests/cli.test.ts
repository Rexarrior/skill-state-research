import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let counter = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(args: string[], input?: unknown) {
  const command = [process.execPath, "run", cli, ...args];
  if (input !== undefined) {
    const path = join(directory, `input-${counter++}.json`);
    await writeFile(path, typeof input === "string" ? input : JSON.stringify(input));
    command.push(path);
  }

  const processResult = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("dependency planner CLI", () => {
  test("plans deterministically with parallel layers and a critical path tie", async () => {
    const result = await run(["plan"], {
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["prep"] },
        { id: "prep", duration: 2 },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 0 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "prep", "build", "test", "ship"],
      layers: [["docs", "lint", "prep"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 0 },
        lint: { start: 0, finish: 2 },
        prep: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "test", "ship"],
    });
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
        { id: "c", duration: 1, dependsOn: ["b"] },
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["c"] },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> c -> b -> a");
  });

  test("rejects malformed JSON and invalid dependencies", async () => {
    const malformed = await run(["plan"], "{");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("invalid JSON");

    const unknown = await run(["plan"], {
      tasks: [{ id: "build", duration: 1, dependsOn: ["missing"] }],
    });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("depends on unknown task: missing");
  });

  test("rejects unknown commands and extra flags", async () => {
    const command = await run(["nope"]);
    expect(command.exitCode).toBe(1);
    expect(command.stderr).toContain("unknown command: nope");

    const flag = await run(["plan", "--wat"]);
    expect(flag.exitCode).toBe(1);
    expect(flag.stderr).toContain("unknown argument or flag: --wat");
  });
});
