import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(import.meta.dir, ".cli-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
const template = join(directory, "template.html");
const data = join(directory, "data.json");
await writeFile(template, "Hello {{name}}!\n{{{raw}}}");
await writeFile(data, JSON.stringify({ name: "世界 & friends", raw: "<b>ok</b>" }));

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("CLI produces exact UTF-8 output", async () => {
  expect(await cli([template, data])).toEqual({ stdout: "Hello 世界 &amp; friends!\n<b>ok</b>", stderr: "", code: 0 });
});
test("CLI errors use stderr with a failure exit", async () => {
  const badJson = join(directory, "bad.json");
  const badTemplate = join(directory, "bad.html");
  await writeFile(badJson, "{");
  await writeFile(badTemplate, "prefix{{else}}");
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, badJson], [badTemplate, data]]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
