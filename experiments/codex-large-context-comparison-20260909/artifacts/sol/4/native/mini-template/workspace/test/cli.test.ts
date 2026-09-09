import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixtureDirectory = join(import.meta.dir, ".tmp-cli");

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe("CLI", () => {
  test("renders files to stdout without extra output", async () => {
    await mkdir(fixtureDirectory, { recursive: true });
    const templatePath = join(fixtureDirectory, "input.tpl");
    const dataPath = join(fixtureDirectory, "data.json");
    await writeFile(templatePath, "Hello, {{name}}!\n", "utf8");
    await writeFile(dataPath, JSON.stringify({ name: "Ada & Bob" }), "utf8");

    const process = Bun.spawn(["bun", "run", "src/cli.ts", templatePath, dataPath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, Ada &amp; Bob!\n");
    expect(stderr).toBe("");
  });

  test("reports errors on stderr and exits non-zero", async () => {
    const process = Bun.spawn(["bun", "run", "src/cli.ts"], {
      cwd: join(import.meta.dir, ".."),
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
