import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const project = join(import.meta.dir, "..");
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(project, ".cli-test-"));
  await Bun.write(join(directory, "template.txt"), "Привет {{name}}!\n");
  await Bun.write(join(directory, "data.json"), JSON.stringify({ name: "<Ada>" }));
  await Bun.write(join(directory, "invalid.json"), "{");
  await Bun.write(join(directory, "broken.txt"), "prefix{{#if name}}");
  await Bun.write(join(directory, "object.txt"), "{{this}}");
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: project, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}
test("CLI emits exact UTF-8 output without an added newline", async () => {
  expect(await cli([join(directory, "template.txt"), join(directory, "data.json")])).toEqual({
    stdout: "Привет &lt;Ada&gt;!\n", stderr: "", code: 0,
  });
  await Bun.write(join(directory, "no-newline.txt"), "{{name}}");
  expect((await cli([join(directory, "no-newline.txt"), join(directory, "data.json")])).stdout).toBe("&lt;Ada&gt;");
});
test("CLI errors are nonzero, stderr-only", async () => {
  for (const args of [
    [], ["one"], ["one", "two", "three"],
    [join(directory, "missing.txt"), join(directory, "data.json")],
    [join(directory, "template.txt"), join(directory, "invalid.json")],
    [join(directory, "broken.txt"), join(directory, "data.json")],
    [join(directory, "object.txt"), join(directory, "data.json")],
  ]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
