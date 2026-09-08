import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

let directory: string;
const cli = resolve(import.meta.dir, "../src/cli.ts");

beforeAll(async () => {
  directory = await mkdtemp(resolve(import.meta.dir, ".cli-test-"));
  await Promise.all([
    writeFile(resolve(directory, "template.txt"), " Héllo {{name}}!\n"),
    writeFile(resolve(directory, "data.json"), JSON.stringify({ name: "世界 & all" })),
    writeFile(resolve(directory, "invalid.json"), "{oops"),
    writeFile(resolve(directory, "broken.txt"), "{{#if name}}"),
    writeFile(resolve(directory, "object.txt"), "{{this}}"),
    writeFile(resolve(directory, "empty.txt"), ""),
  ]);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI reads UTF-8 and writes exactly the result", async () => {
  expect(await run(resolve(directory, "template.txt"), resolve(directory, "data.json")))
    .toEqual({ stdout: " Héllo 世界 &amp; all!\n", stderr: "", code: 0 });
});

test("CLI handles empty output", async () => {
  expect(await run(resolve(directory, "empty.txt"), resolve(directory, "data.json")))
    .toEqual({ stdout: "", stderr: "", code: 0 });
});

test("CLI errors use stderr, exit nonzero, and never emit partial output", async () => {
  const cases = [
    [], ["one"], ["one", "two", "three"],
    [resolve(directory, "missing.txt"), resolve(directory, "data.json")],
    [resolve(directory, "template.txt"), resolve(directory, "missing.json")],
    [resolve(directory, "template.txt"), resolve(directory, "invalid.json")],
    [resolve(directory, "broken.txt"), resolve(directory, "data.json")],
    [resolve(directory, "object.txt"), resolve(directory, "data.json")],
  ];
  for (const args of cases) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
