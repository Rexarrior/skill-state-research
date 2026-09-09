import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".cli-fixture-"));
  await Promise.all([
    writeFile(join(directory, "template.txt"), "Hello {{name}}!\n"),
    writeFile(join(directory, "data.json"), JSON.stringify({ name: "世界 & Bun" })),
    writeFile(join(directory, "invalid.json"), "{broken"),
    writeFile(join(directory, "invalid.txt"), "{{#if name}}"),
    writeFile(join(directory, "empty.txt"), ""),
    writeFile(join(directory, "no-newline.txt"), "{{name}}"),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI renders UTF-8 with exact stdout", async () => {
  expect(await cli([join(directory, "template.txt"), join(directory, "data.json")]))
    .toEqual({ stdout: "Hello 世界 &amp; Bun!\n", stderr: "", code: 0 });
  expect(await cli([join(directory, "no-newline.txt"), join(directory, "data.json")]))
    .toEqual({ stdout: "世界 &amp; Bun", stderr: "", code: 0 });
  expect(await cli([join(directory, "empty.txt"), join(directory, "data.json")]))
    .toEqual({ stdout: "", stderr: "", code: 0 });
});

test("CLI failures write only stderr and exit non-zero", async () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(directory, "missing.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "invalid.json")],
    [join(directory, "invalid.txt"), join(directory, "data.json")],
  ]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
