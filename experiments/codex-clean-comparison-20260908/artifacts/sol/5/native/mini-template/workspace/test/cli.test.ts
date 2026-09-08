import { describe, expect, test } from "bun:test";

const projectRoot = new URL("..", import.meta.url).pathname;

describe("CLI", () => {
  test("renders files to stdout without extra output", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "src/cli.ts",
        "test/fixtures/greeting.txt",
        "test/fixtures/data.json",
      ],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("Hello, Ada &amp; Lin!\n");
    expect(child.stderr.toString()).toBe("");
  });

  test("writes usage errors to stderr and exits non-zero", () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli.ts"],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).not.toBe(0);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("Usage:");
  });
});
