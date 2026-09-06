import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

describe("CLI", () => {
  test("renders files and writes only the result to stdout", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      "src/cli.ts",
      "test/fixtures/cli-template.txt",
      "test/fixtures/cli-data.json",
    ], { cwd: projectRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("Hello, &lt;Ada&gt;!\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("reports errors on stderr and exits non-zero", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      "src/cli.ts",
    ], { cwd: projectRoot });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Usage:");
  });
});
