import { afterEach, describe, expect, test } from "bun:test";

const files: string[] = [];

async function run(input: unknown, ...extra: string[]) {
  const path = `${import.meta.dir}/fixture-${crypto.randomUUID()}.json`;
  files.push(path);
  await Bun.write(path, JSON.stringify(input));
  return Bun.$`bun run ${import.meta.dir}/../src/cli.ts plan ${path} ${extra}`.quiet().nothrow();
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => Bun.file(file).delete()));
});

describe("dependency planner", () => {
  test("plans deterministically with concurrency and critical-path ties", async () => {
    const result = await run({ tasks: [
      { id: "ship", duration: 1, dependsOn: ["build", "test"] },
      { id: "test", duration: 2, dependsOn: ["lint"] },
      { id: "build", duration: 2, dependsOn: ["lint"] },
      { id: "lint", duration: 1 },
    ] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      order: ["lint", "build", "test", "ship"],
      layers: [["lint"], ["build", "test"], ["ship"]],
      earliest: {
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 3 },
        test: { start: 1, finish: 3 },
        ship: { start: 3, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build", "ship"],
    });
  });

  test("supports empty input and zero-duration tasks", async () => {
    const empty = await run({ tasks: [] });
    expect(JSON.parse(empty.stdout.toString())).toEqual({
      order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
    });
    const zero = await run({ tasks: [{ id: "b", duration: 0 }, { id: "a", duration: 0 }] });
    expect(JSON.parse(zero.stdout.toString()).criticalPath).toEqual(["a"]);
  });

  test("reports a deterministic concrete cycle", async () => {
    const result = await run({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] },
      { id: "a", duration: 1, dependsOn: ["b"] },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("a -> b -> a");
  });

  test("rejects schema errors and unknown flags", async () => {
    const invalid = await run({ tasks: [{ id: "a", duration: -1 }] });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain("finite non-negative number");

    const flagged = await run({ tasks: [] }, "--verbose");
    expect(flagged.exitCode).not.toBe(0);
    expect(flagged.stderr.toString()).toContain("Unknown flag");
  });
});
