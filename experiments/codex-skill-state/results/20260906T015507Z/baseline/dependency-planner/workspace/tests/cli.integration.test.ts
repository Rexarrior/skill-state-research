import { describe, expect, test } from "bun:test";

const cli = `${import.meta.dir}/../src/cli.ts`;

function run(...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI", () => {
  test("prints exactly one plan object", () => {
    const result = run("plan", `${import.meta.dir}/fixtures/basic.json`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const outputLines = result.stdout.toString().trimEnd().split("\n");
    expect(outputLines).toHaveLength(1);
    expect(JSON.parse(outputLines[0]!)).toEqual({
      order: ["docs", "lint", "build"],
      layers: [["docs", "lint"], ["build"]],
      earliest: {
        docs: { start: 0, finish: 2 },
        lint: { start: 0, finish: 1 },
        build: { start: 1, finish: 4 },
      },
      totalDuration: 4,
      criticalPath: ["lint", "build"],
    });
  });

  test("fails with a concrete cycle", () => {
    const result = run("plan", `${import.meta.dir}/fixtures/cycle.json`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("cycle detected: a -> b -> a");
  });

  test("rejects unknown flags and invalid JSON", () => {
    const unknownFlag = run("plan", `${import.meta.dir}/fixtures/basic.json`, "--verbose");
    expect(unknownFlag.exitCode).not.toBe(0);
    expect(unknownFlag.stderr.toString()).toContain("unknown argument or flag: --verbose");

    const invalidJson = run("plan", import.meta.path);
    expect(invalidJson.exitCode).not.toBe(0);
    expect(invalidJson.stderr.toString()).toContain("invalid JSON");
  });
});
