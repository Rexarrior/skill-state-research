import { afterEach, describe, expect, test } from "bun:test";

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((path) => Bun.file(path).delete()));
});

async function run(input: unknown) {
  const path = `${import.meta.dir}/test-${crypto.randomUUID()}.json`;
  temporaryFiles.push(path);
  await Bun.write(path, JSON.stringify(input));
  const process = Bun.spawn(["bun", "run", `${import.meta.dir}/cli.ts`, "plan", path], {
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
  test("plans deterministic order, concurrency, timings, and critical path", async () => {
    const result = await run({
      tasks: [
        { id: "deploy", duration: 1, dependsOn: ["build", "test"] },
        { id: "test", duration: 3, dependsOn: ["lint"] },
        { id: "build", duration: 3, dependsOn: ["lint"] },
        { id: "lint", duration: 2 },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      order: ["lint", "build", "test", "deploy"],
      layers: [["lint"], ["build", "test"], ["deploy"]],
      earliest: {
        lint: { start: 0, finish: 2 },
        build: { start: 2, finish: 5 },
        test: { start: 2, finish: 5 },
        deploy: { start: 5, finish: 6 },
      },
      totalDuration: 6,
      criticalPath: ["lint", "build", "deploy"],
    });
  });

  test("handles empty input and zero-duration tasks", async () => {
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
        { id: "b", duration: 1, dependsOn: ["a"] },
        { id: "a", duration: 1, dependsOn: ["b"] },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("a -> b -> a");
  });

  test("rejects invalid references and duplicate dependencies", async () => {
    const unknown = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["x"] }] });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("unknown task: x");

    const duplicate = await run({ tasks: [{ id: "a", duration: 1, dependsOn: ["x", "x"] }] });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain("duplicate id: x");
  });
});
