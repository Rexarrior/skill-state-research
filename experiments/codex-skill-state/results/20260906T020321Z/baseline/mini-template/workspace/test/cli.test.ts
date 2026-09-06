import { describe, expect, test } from "bun:test";

const cliPath = `${import.meta.dir}/../src/cli.ts`;
const templatePath = `${import.meta.dir}/fixtures/template.txt`;
const dataPath = `${import.meta.dir}/fixtures/data.json`;

describe("CLI", () => {
  test("writes only rendered UTF-8 text to stdout", async () => {
    const child = Bun.spawn([process.execPath, "run", cliPath, templatePath, dataPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe("Привет, Ada &amp; Co!\n");
  });

  test("reports usage on stderr and exits non-zero", async () => {
    const child = Bun.spawn([process.execPath, "run", cliPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage:");
  });
});
