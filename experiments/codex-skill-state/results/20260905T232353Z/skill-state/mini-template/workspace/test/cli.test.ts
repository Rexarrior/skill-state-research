import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("CLI renders files to stdout without extra output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mini-template-"));
  directories.push(directory);
  const templatePath = join(directory, "input.tpl");
  const dataPath = join(directory, "data.json");
  await writeFile(templatePath, "Hello, {{name}}!\n", "utf8");
  await writeFile(dataPath, JSON.stringify({ name: "A&B" }), "utf8");

  const process = Bun.spawn(["bun", "run", "src/cli.ts", templatePath, dataPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(process.stdout).text()).toBe("Hello, A&amp;B!\n");
  expect(await new Response(process.stderr).text()).toBe("");
  expect(await process.exited).toBe(0);
});

test("CLI reports errors on stderr and exits non-zero", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts"], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(process.stdout).text()).toBe("");
  expect(await new Response(process.stderr).text()).toMatch(/Usage:/);
  expect(await process.exited).not.toBe(0);
});
