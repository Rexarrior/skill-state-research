import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = await mkdtemp(join(tmpdir(), "dependency-planner-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

async function run(input: unknown, ...extra: string[]) {
  const path = join(directory, `${crypto.randomUUID()}.json`);
  await writeFile(path, JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "plan", path, ...extra], {
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
  test("plans deterministically with parallel layers and a lexical critical-path tie", async () => {
    const result = await run({
      tasks: [
        { id: "ship", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
        { id: "docs", duration: 1 },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["docs", "lint", "build", "test", "ship"],
      layers: [["docs", "lint"], ["build", "test"], ["ship"]],
      earliest: {
        docs: { start: 0, finish: 1 },
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        ship: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty plans and zero-duration tasks", async () => {
    expect(JSON.parse((await run({ tasks: [] })).stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const zero = await run({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] });
    expect(JSON.parse(zero.stdout).criticalPath).toEqual(["a"]);
  });

  test("compares complete critical-path sequences when zero-duration prefixes tie", async () => {
    const result = await run({ tasks: [
      { id: "a", duration: 1 },
      { id: "z", duration: 0, dependsOn: ["a"] },
      { id: "x", duration: 1, dependsOn: ["a", "z"] },
    ] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a", "x"]);
  });

  test("reports a deterministic cycle", async () => {
    const result = await run({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> b -> a");
  });

  test.each([
    [{}, '"tasks" must be an array'],
    [{ tasks: [{ id: "a", duration: -1 }] }, "finite non-negative"],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, "duplicate task id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, "unknown id"],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, "cannot depend on itself"],
  ] as const)("rejects invalid input", async (input, message) => {
    const result = await run(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  test("rejects extra command arguments", async () => {
    const result = await run({ tasks: [] }, "--wat");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });
});
