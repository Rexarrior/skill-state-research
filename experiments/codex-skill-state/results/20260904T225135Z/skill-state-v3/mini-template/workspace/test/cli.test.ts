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
  const template = join(directory, "input.tpl");
  const data = join(directory, "data.json");
  await writeFile(template, "Hello, {{name}}!");
  await writeFile(data, JSON.stringify({ name: "A&B" }));

  const process = Bun.spawn(["bun", "run", "src/cli.ts", template, data], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(0);
  expect(await new Response(process.stdout).text()).toBe("Hello, A&amp;B!");
  expect(await new Response(process.stderr).text()).toBe("");
});

test("CLI sends errors to stderr and exits non-zero", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts"], { stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).not.toBe(0);
  expect(await new Response(process.stdout).text()).toBe("");
  expect(await new Response(process.stderr).text()).toContain("Usage:");
});
