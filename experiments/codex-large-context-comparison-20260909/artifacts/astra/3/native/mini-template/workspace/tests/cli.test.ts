import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".cli-fixtures-"));
  await Promise.all([
    Bun.write(join(directory, "template.txt"), "Hello {{name}}!\n"),
    Bun.write(join(directory, "data.json"), JSON.stringify({ name: "世界<&" })),
    Bun.write(join(directory, "bad.json"), "{invalid"),
    Bun.write(join(directory, "bad.txt"), "prefix{{#if name}}"),
    Bun.write(join(directory, "object.json"), JSON.stringify({ name: {} })),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI emits only exact UTF-8 rendered output", async () => {
  expect(await cli([join(directory, "template.txt"), join(directory, "data.json")]))
    .toEqual({ stdout: "Hello 世界&lt;&amp;!\n", stderr: "", code: 0 });
});

test("CLI reports usage, IO, JSON, syntax and scalar errors without partial stdout", async () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(directory, "missing"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "missing.json")],
    [join(directory, "template.txt"), join(directory, "bad.json")],
    [join(directory, "bad.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "object.json")],
  ]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
