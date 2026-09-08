import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

let directory: string;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, ".cli-test-"));
  await Promise.all([
    Bun.write(join(directory, "template.txt"), "Hi {{name}} — 世界!"),
    Bun.write(join(directory, "data.json"), JSON.stringify({ name: "<Ada>" })),
    Bun.write(join(directory, "invalid.json"), "{broken"),
    Bun.write(join(directory, "invalid.txt"), "prefix{{#if x}}"),
    Bun.write(join(directory, "object.json"), JSON.stringify({ name: {} })),
  ]);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI emits exact UTF-8 rendered output without a newline", async () => {
  expect(await run([join(directory, "template.txt"), join(directory, "data.json")]))
    .toEqual({ stdout: "Hi &lt;Ada&gt; — 世界!", stderr: "", code: 0 });
});

test("CLI errors have stderr, nonzero status, and no partial stdout", async () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(directory, "missing"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "missing")],
    [join(directory, "template.txt"), join(directory, "invalid.json")],
    [join(directory, "invalid.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "object.json")],
  ]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe("");
  }
});
