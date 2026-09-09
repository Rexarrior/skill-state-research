import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(import.meta.dir, ".cli-fixtures-"));
const cli = join(import.meta.dir, "../src/cli.ts");
afterAll(() => rm(directory, { recursive: true, force: true }));

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI renders UTF-8 with no extra stdout", async () => {
  const template = join(directory, "template.txt");
  const data = join(directory, "data.json");
  await Promise.all([writeFile(template, "Привет {{name}}!"), writeFile(data, '{"name":"世界 &"}')]);
  expect(await run(template, data)).toEqual({ stdout: "Привет 世界 &amp;!", stderr: "", code: 0 });
});

test("CLI failures use stderr and nonzero exit without partial rendering", async () => {
  const template = join(directory, "bad-template.txt");
  const data = join(directory, "bad-data.json");
  await Promise.all([writeFile(template, "prefix{{value}}"), writeFile(data, '{"value":{}}')]);
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, data]]) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
  await writeFile(data, "invalid json");
  const invalid = await run(template, data);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr.length).toBeGreaterThan(0);
  await Promise.all([writeFile(template, "{{#if value}}"), writeFile(data, "{}")]);
  const syntax = await run(template, data);
  expect(syntax.code).not.toBe(0);
  expect(syntax.stdout).toBe("");
  expect(syntax.stderr).toContain("line 1, column 1");
});
