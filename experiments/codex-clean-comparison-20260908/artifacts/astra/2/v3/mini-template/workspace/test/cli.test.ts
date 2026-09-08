import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(import.meta.dir, ".cli-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
await writeFile(template, "Привет {{name}}!\n");
await writeFile(data, JSON.stringify({ name: "<&" }));

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
  expect(await cli([template, data])).toEqual({ stdout: "Привет &lt;&amp;!\n", stderr: "", code: 0 });
});
test("CLI errors are confined to stderr", async () => {
  const invalid = join(directory, "invalid.json");
  const broken = join(directory, "broken.txt");
  await writeFile(invalid, "{broken");
  await writeFile(broken, "prefix{{#if name}}");
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, invalid], [broken, data]]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
