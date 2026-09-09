import { describe, expect, test } from "bun:test";

const projectRoot = new URL("..", import.meta.url).pathname;

describe("CLI", () => {
  test("writes only rendered text to stdout", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli.ts", "test/fixtures/greeting.txt", "test/fixtures/data.json"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("Hello, A&amp;B! [0: one][1: two]\n");
    expect(result.stderr.toString()).toBe("");
  });

  test("reports usage errors on stderr", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli.ts"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toMatch(/Usage:/);
  });
});
