import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".cli-test-"));
  await writeFile(join(directory, "template.txt"), "Héllo {{name}}!\n{{{raw}}}");
  await writeFile(join(directory, "data.json"), JSON.stringify({ name: "<世界>", raw: "done" }));
  await writeFile(join(directory, "invalid.json"), "{bad");
  await writeFile(join(directory, "invalid.txt"), "prefix{{#if x}}");
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI writes exact UTF-8 output without an extra newline", async () => {
  expect(await cli(join(directory, "template.txt"), join(directory, "data.json")))
    .toEqual({ stdout: "Héllo &lt;世界&gt;!\ndone", stderr: "", code: 0 });
});

test("CLI errors use stderr and never emit partial output", async () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(directory, "missing"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "invalid.json")],
    [join(directory, "invalid.txt"), join(directory, "data.json")],
  ]) {
    const result = await cli(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
