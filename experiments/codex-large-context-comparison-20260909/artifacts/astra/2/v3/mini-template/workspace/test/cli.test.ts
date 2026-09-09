import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
async function run(args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("CLI exact UTF-8 output and failure handling", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".cli-test-"));
  try {
    const template = join(dir, "template.txt");
    const data = join(dir, "data.json");
    await writeFile(template, "Hello {{name}} — 世界!");
    await writeFile(data, JSON.stringify({ name: "<Ada>" }));
    expect(await run([template, data])).toEqual({ stdout: "Hello &lt;Ada&gt; — 世界!", stderr: "", code: 0 });
    for (const args of [[], [template], [template, data, "extra"], [join(dir, "absent"), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, "invalid JSON");
    expect((await run([template, data])).code).not.toBe(0);
    await writeFile(data, "{}");
    await writeFile(template, "prefix\n{{else}}");
    const result = await run([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("line 2, column 1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
