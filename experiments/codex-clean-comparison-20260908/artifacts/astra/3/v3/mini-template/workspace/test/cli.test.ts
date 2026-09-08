import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let directory: string;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
beforeAll(async () => {
  directory = await mkdtemp(join(process.cwd(), ".cli-test-"));
  await Promise.all([
    writeFile(join(directory, "template"), "Hi {{name}}!\n"),
    writeFile(join(directory, "data.json"), JSON.stringify({ name: "世界 & Ada" })),
    writeFile(join(directory, "bad.json"), "{"),
    writeFile(join(directory, "bad-template"), "{{else}}"),
    writeFile(join(directory, "object.json"), JSON.stringify({ name: {} })),
    writeFile(join(directory, "empty-template"), ""),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI writes exact UTF-8 output", async () => {
  expect(await run([join(directory, "template"), join(directory, "data.json")]))
    .toEqual({ stdout: "Hi 世界 &amp; Ada!\n", stderr: "", code: 0 });
});

test("CLI failures write only stderr and exit nonzero", async () => {
  for (const args of [[], ["one"], ["one", "two", "three"],
    [join(directory, "missing"), join(directory, "data.json")],
    [join(directory, "template"), join(directory, "missing.json")],
    [join(directory, "template"), join(directory, "object.json")],
    [join(directory, "template"), join(directory, "bad.json")],
    [join(directory, "bad-template"), join(directory, "data.json")],
  ]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});

test("CLI preserves empty output without adding a newline", async () => {
  expect(await run([join(directory, "empty-template"), join(directory, "data.json")]))
    .toEqual({ stdout: "", stderr: "", code: 0 });
});
