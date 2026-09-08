import { describe, expect, test } from "bun:test";

const projectRoot = new URL("..", import.meta.url).pathname;

async function runCli(args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, "run", "src/cli.ts", ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI", () => {
  test("writes only rendered output to stdout", async () => {
    const result = await runCli(["test/fixtures/greeting.txt", "test/fixtures/data.json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello &lt;Bun&gt;!\n");
    expect(result.stderr).toBe("");
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const result = await runCli([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
});
