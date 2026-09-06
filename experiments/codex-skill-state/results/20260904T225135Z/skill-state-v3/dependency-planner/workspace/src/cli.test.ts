import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
let testDirectory: string;
let inputNumber = 0;

beforeAll(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
});

afterAll(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

async function run(
  input: unknown,
  extraArguments: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const inputPath = join(testDirectory, `input-${inputNumber++}.json`);
  await Bun.write(inputPath, JSON.stringify(input));

  const child = Bun.spawn(
    [process.execPath, "run", cliPath, "plan", inputPath, ...extraArguments],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("dependency planner CLI", () => {
  test("produces a deterministic parallel plan", async () => {
    const result = await run({
      tasks: [
        { id: "release", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["lint", "build", "test", "release"],
      layers: [["lint"], ["build", "test"], ["release"]],
      earliest: {
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        release: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "release"],
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
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> b -> a");
  });

  test("rejects invalid dependencies and unknown flags", async () => {
    const invalid = await run({
      tasks: [{ id: "build", duration: 1, dependsOn: ["missing"] }],
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("unknown task: missing");

    const unknownFlag = await run({ tasks: [] }, ["--verbose"]);
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stderr).toContain("unknown argument or flag: --verbose");
  });
});
