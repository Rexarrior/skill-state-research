import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI", () => {
  test("writes only rendered output to stdout", async () => {
    const process = Bun.spawn(
      [
        Bun.argv[0],
        "run",
        "src/cli.ts",
        "test/fixtures/greeting.txt",
        "test/fixtures/data.json",
      ],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, Ada &amp; Co!\n");
    expect(stderr).toBe("");
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const process = Bun.spawn([Bun.argv[0], "run", "src/cli.ts"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });
});
