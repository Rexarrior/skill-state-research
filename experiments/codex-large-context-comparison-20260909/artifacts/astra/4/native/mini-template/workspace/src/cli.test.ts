import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let directory: string;
const cli = join(import.meta.dir, "cli.ts");

beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".cli-test-"));
  await Promise.all([
    writeFile(join(directory, "template.txt"), "Hello {{name}}!\n{{{text}}}"),
    writeFile(join(directory, "data.json"), JSON.stringify({ name: "Zoë & 李", text: "<ok>" })),
    writeFile(join(directory, "invalid.json"), "{broken"),
    writeFile(join(directory, "broken.txt"), "text before error\n{{else}}"),
    writeFile(join(directory, "object.json"), JSON.stringify({ name: {} })),
    writeFile(join(directory, "empty.txt"), ""),
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

test("CLI emits exact UTF-8 output without an extra newline", async () => {
  expect(await run(join(directory, "template.txt"), join(directory, "data.json")))
    .toEqual({ stdout: "Hello Zoë &amp; 李!\n<ok>", stderr: "", code: 0 });
});

test("CLI supports empty output", async () => {
  expect(await run(join(directory, "empty.txt"), join(directory, "data.json")))
    .toEqual({ stdout: "", stderr: "", code: 0 });
});

test("CLI reports argument, file, JSON, syntax, and value errors without partial stdout", async () => {
  const scenarios = [
    [], ["only-one"], ["a", "b", "c"],
    [join(directory, "missing.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "missing.json")],
    [join(directory, "template.txt"), join(directory, "invalid.json")],
    [join(directory, "broken.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "object.json")],
  ];
  for (const args of scenarios) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
