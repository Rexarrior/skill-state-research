import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

let directory: string;
const cli = resolve(import.meta.dir, "../src/cli.ts");

beforeAll(async () => {
  directory = await mkdtemp(resolve(import.meta.dir, ".cli-fixtures-"));
  await Promise.all([
    writeFile(resolve(directory, "template.txt"), "Привет {{name}}!\n"),
    writeFile(resolve(directory, "data.json"), JSON.stringify({ name: "A&B" })),
    writeFile(resolve(directory, "invalid.json"), "{broken"),
    writeFile(resolve(directory, "broken.txt"), "partial{{else}}"),
  ]);
});

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI writes exact UTF-8 rendered output", async () => {
  const result = await run(resolve(directory, "template.txt"), resolve(directory, "data.json"));
  expect(result).toEqual({ stdout: "Привет A&amp;B!\n", stderr: "", code: 0 });
});

test("CLI rejects missing and extra arguments", async () => {
  for (const args of [[], ["one"], ["one", "two", "three"]]) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }
});

test("CLI reports file, JSON, and template errors without partial output", async () => {
  for (const [template, data] of [
    ["missing.txt", "data.json"], ["template.txt", "missing.json"],
    ["template.txt", "invalid.json"], ["broken.txt", "data.json"],
  ]) {
    const result = await run(resolve(directory, template!), resolve(directory, data!));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
