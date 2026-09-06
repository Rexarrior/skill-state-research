import { describe, expect, test } from "bun:test";

const projectDirectory = new URL("..", import.meta.url).pathname;

async function runCli(templateName: string, dataName: string) {
  const templatePath = new URL(`fixtures/${templateName}`, import.meta.url).pathname;
  const dataPath = new URL(`fixtures/${dataName}`, import.meta.url).pathname;
  const process = Bun.spawn(
    ["bun", "run", "src/cli.ts", templatePath, dataPath],
    { cwd: projectDirectory, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI", () => {
  test("writes only rendered text to stdout", async () => {
    const result = await runCli("greeting.txt", "data.json");
    expect(result).toEqual({ stdout: "Hello Ada!\n", stderr: "", exitCode: 0 });
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const result = await runCli("greeting.txt", "invalid.json");
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });
});
