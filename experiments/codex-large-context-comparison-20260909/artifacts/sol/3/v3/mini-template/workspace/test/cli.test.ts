import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "mini-template-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

describe("CLI", () => {
  test("renders files to stdout only", async () => {
    const templatePath = join(directory, "template.txt");
    const dataPath = join(directory, "data.json");
    await writeFile(templatePath, "Hello, {{name}}!");
    await writeFile(dataPath, JSON.stringify({ name: "Bun & Co" }));

    const process = Bun.spawn(["bun", "run", "src/cli.ts", templatePath, dataPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, Bun &amp; Co!");
    expect(stderr).toBe("");
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const process = Bun.spawn(["bun", "run", "src/cli.ts"], {
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
