import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CLI", () => {
  test("renders UTF-8 files to stdout only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-template-"));
    directories.push(directory);
    const template = join(directory, "input.tpl");
    const data = join(directory, "data.json");
    await writeFile(template, "Привет, {{name}}!", "utf8");
    await writeFile(data, JSON.stringify({ name: "мир" }), "utf8");

    const process = Bun.spawn(["bun", "run", "src/cli.ts", template, data], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Привет, мир!");
    expect(stderr).toBe("");
  });

  test("reports JSON errors on stderr and exits non-zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-template-"));
    directories.push(directory);
    const template = join(directory, "input.tpl");
    const data = join(directory, "data.json");
    await writeFile(template, "ok", "utf8");
    await writeFile(data, "{", "utf8");

    const process = Bun.spawn(["bun", "run", "src/cli.ts", template, data], {
      cwd: import.meta.dir + "/..",
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
    expect(stderr).toMatch(/^Error: /);
  });
});
