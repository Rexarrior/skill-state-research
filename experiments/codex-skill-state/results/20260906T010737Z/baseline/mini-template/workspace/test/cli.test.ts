import { describe, expect, test } from "bun:test";

describe("CLI", () => {
  test("renders files to stdout without extra output", async () => {
    const process = Bun.spawn({
      cmd: [
        Bun.which("bun")!,
        "run",
        "src/cli.ts",
        "test/fixtures/template.txt",
        "test/fixtures/data.json",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("Hello, Ada &amp; Lin!\nitem 0: <one>\nitem 1: two\n\n");
  });

  test("writes errors to stderr and exits non-zero", async () => {
    const process = Bun.spawn({
      cmd: [Bun.which("bun")!, "run", "src/cli.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });
});
