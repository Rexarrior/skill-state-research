import { describe, expect, test } from "bun:test";

const projectDirectory = new URL("..", import.meta.url).pathname;

function runCli(...arguments_: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...arguments_],
    cwd: projectDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("CLI", () => {
  test("writes only rendered output to stdout", () => {
    const process = runCli("test/fixtures/greeting.txt", "test/fixtures/data.json");
    expect(process.exitCode).toBe(0);
    expect(process.stdout.toString()).toBe("Hello, Ada &amp; Bob! [0:admin][1:author]\n");
    expect(process.stderr.toString()).toBe("");
  });

  test("reports errors to stderr and exits non-zero", () => {
    const process = runCli("test/fixtures/greeting.txt", "test/fixtures/invalid.json");
    expect(process.exitCode).not.toBe(0);
    expect(process.stdout.toString()).toBe("");
    expect(process.stderr.toString()).toMatch(/^mini-template: .+\n$/);
  });

  test("requires exactly two arguments", () => {
    const process = runCli();
    expect(process.exitCode).not.toBe(0);
    expect(process.stdout.toString()).toBe("");
    expect(process.stderr.toString()).toContain("Usage:");
  });
});
