import { describe, expect, test } from "bun:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const template = new URL("./fixtures/template.txt", import.meta.url).pathname;
const data = new URL("./fixtures/data.json", import.meta.url).pathname;
const invalidData = new URL("./fixtures/invalid.json", import.meta.url).pathname;

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI", () => {
  test("prints only the rendered template to stdout", async () => {
    const result = await run([template, data]);
    expect(result).toEqual({
      stdout: "Hello, Ada &amp; Bob!\n- 0: one\n- 1: two\n\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const result = await run([template, invalidData]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("Error:");
    expect(result.exitCode).not.toBe(0);
  });
});
