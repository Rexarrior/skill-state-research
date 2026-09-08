import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true });
  temporaryDirectory = undefined;
});

describe("CLI", () => {
  test("renders files to stdout without extra output", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mini-template-"));
    const templatePath = join(temporaryDirectory, "template.txt");
    const dataPath = join(temporaryDirectory, "data.json");
    await Promise.all([
      writeFile(templatePath, "Hello {{name}}!\n", "utf8"),
      writeFile(dataPath, JSON.stringify({ name: "A&B" }), "utf8"),
    ]);

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
    expect(stdout).toBe("Hello A&amp;B!\n");
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
