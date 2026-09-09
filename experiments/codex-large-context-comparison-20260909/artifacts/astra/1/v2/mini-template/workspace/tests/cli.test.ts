import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(import.meta.dir, ".cli-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
const cli = join(import.meta.dir, "../src/cli.ts");

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI writes exact UTF-8 output", async () => {
  await Bun.write(template, "Hello {{name}}!\n ");
  await Bun.write(data, JSON.stringify({ name: "世界 & Ada" }));
  expect(await run([template, data])).toEqual({ stdout: "Hello 世界 &amp; Ada!\n ", stderr: "", code: 0 });
});

test("CLI errors have no stdout and exit nonzero", async () => {
  await Bun.write(template, "{{else}}");
  await Bun.write(data, "{}");
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, data]]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
  await Bun.write(data, "invalid json");
  const result = await run([template, data]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.length).toBeGreaterThan(0);
});
