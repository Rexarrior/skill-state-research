import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => unlink(file).catch(() => undefined)));
});

async function run(input: unknown) {
  const file = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
  files.push(file);
  await Bun.write(file, JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/cli.ts`, "plan", file], {
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

async function runArgs(args: string[]) {
  const process = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/cli.ts`, ...args], {
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
  test("plans deterministically, in parallel, with a lexicographic critical-path tie", async () => {
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

  test("handles an empty project", async () => {
    const result = await run({ tasks: [] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
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
    expect(result.stderr).toContain("a -> b -> c -> a");
  });

  test("rejects invalid references and duplicate dependencies", async () => {
    const unknown = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("unknown task: x");

    const duplicate = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }, { id: "b", duration: 1 }] });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate id: b");
  });

  test("uses standard full-sequence ordering for zero-duration paths", async () => {
    const result = await run({
      tasks: [
        { id: "z", duration: 0, dependsOn: ["a", "aa"] },
        { id: "aa", duration: 0 },
        { id: "a", duration: 0 },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).criticalPath).toEqual(["a"]);
  });

  test("rejects malformed JSON and invalid task fields", async () => {
    const file = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
    files.push(file);
    await Bun.write(file, "{not json");
    const malformed = await runArgs(["plan", file]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("invalid JSON");

    const invalid = await run({ tasks: [{ id: "a", duration: -1, dependsOn: [] }] });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("finite non-negative number");

    const self = await run({ tasks: [{ id: "a", duration: 0, dependsOn: ["a"] }] });
    expect(self.exitCode).not.toBe(0);
    expect(self.stderr).toContain("cannot depend on itself");
  });

  test("rejects unknown commands, flags, and extra arguments", async () => {
    const unknownCommand = await runArgs(["schedule"]);
    expect(unknownCommand.exitCode).not.toBe(0);
    expect(unknownCommand.stderr).toContain("unknown command: schedule");

    const unknownFlag = await runArgs(["plan", "--verbose"]);
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stderr).toContain("unknown flag: --verbose");

    const extra = await runArgs(["plan", "one.json", "two.json"]);
    expect(extra.exitCode).not.toBe(0);
    expect(extra.stderr).toContain("exactly one input file");
  });
});
