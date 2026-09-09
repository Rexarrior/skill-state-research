import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(root, ".cli-test-"));
  await Promise.all([
    writeFile(join(directory, "template.txt"), "Héllo {{name}}!\n{{#each items}}{{this}}{{/each}}"),
    writeFile(join(directory, "data.json"), JSON.stringify({ name: "世界 & Bun", items: [1, 2] })),
    writeFile(join(directory, "bad.json"), "{ invalid"),
    writeFile(join(directory, "broken.txt"), "prefix{{#if name}}"),
    writeFile(join(directory, "object.txt"), "prefix{{items}}"),
    writeFile(join(directory, "empty.txt"), ""),
  ]);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI emits only exact rendered UTF-8 text", async () => {
  expect(await cli(join(directory, "template.txt"), join(directory, "data.json")))
    .toEqual({ stdout: "Héllo 世界 &amp; Bun!\n12", stderr: "", code: 0 });
});

test("CLI supports empty output", async () => {
  expect(await cli(join(directory, "empty.txt"), join(directory, "data.json")))
    .toEqual({ stdout: "", stderr: "", code: 0 });
});

test("CLI rejects missing and extra arguments", async () => {
  for (const args of [[], ["one"], ["one", "two", "three"]]) {
    const result = await cli(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }
});

test("CLI reports file, JSON, syntax, and rendering errors without partial stdout", async () => {
  for (const [template, data, error] of [
    ["missing.txt", "data.json", /ENOENT/],
    ["template.txt", "missing.json", /ENOENT/],
    ["template.txt", "bad.json", /JSON/i],
    ["broken.txt", "data.json", /Unclosed if block.*line 1, column 7/],
    ["object.txt", "data.json", /Cannot render/],
  ] as const) {
    const result = await cli(join(directory, template), join(directory, data));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(error);
  }
});
