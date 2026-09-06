import { describe, expect, test } from "bun:test";

const decoder = new TextDecoder();

describe("CLI", () => {
  test("renders files to stdout without extra output", async () => {
    const process = Bun.spawn([
      Bun.which("bun")!,
      "run",
      "src/cli.ts",
      "test/fixtures/template.txt",
      "test/fixtures/data.json",
    ], { stdout: "pipe", stderr: "pipe" });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, &lt;Ada&gt;! <b>ready</b>\n");
    expect(stderr).toBe("");
  });

  test("reports usage errors only on stderr and exits non-zero", async () => {
    const process = Bun.spawn([Bun.which("bun")!, "run", "src/cli.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderrBytes] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).arrayBuffer(),
    ]);
    const stderr = decoder.decode(stderrBytes);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });
});
