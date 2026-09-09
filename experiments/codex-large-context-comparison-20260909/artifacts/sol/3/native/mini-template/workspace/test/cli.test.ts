import { describe, expect, test } from "bun:test";

describe("CLI", () => {
  test("writes only rendered text to stdout", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        "src/cli.ts",
        "test/fixtures/greeting.txt",
        "test/fixtures/data.json",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, A&amp;B! [admin]\n");
    expect(stderr).toBe("");
  });

  test("reports usage on stderr and exits non-zero", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/cli.ts"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage:");
  });
});
