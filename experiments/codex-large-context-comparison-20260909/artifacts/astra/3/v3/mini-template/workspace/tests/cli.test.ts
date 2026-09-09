import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

test("CLI emits exact UTF-8 output and reports errors only to stderr", async () => {
  const dir = await mkdtemp(join(import.meta.dir, ".cli-"));
  const template = join(dir, "template.txt");
  const data = join(dir, "data.json");
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  try {
    await writeFile(template, "Héllo {{name}}!");
    await writeFile(data, JSON.stringify({ name: "世界 &" }));
    expect(await run([template, data])).toEqual({ stdout: "Héllo 世界 &amp;!", stderr: "", code: 0 });
    for (const args of [[], [template], [template, data, data], [join(dir, "missing"), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, "{");
    const invalidJson = await run([template, data]);
    expect(invalidJson.code).not.toBe(0);
    expect(invalidJson.stdout).toBe("");
    expect(invalidJson.stderr.length).toBeGreaterThan(0);
    await writeFile(data, "{}");
    await writeFile(template, "prefix\n{{else}}");
    const invalidTemplate = await run([template, data]);
    expect(invalidTemplate.code).not.toBe(0);
    expect(invalidTemplate.stdout).toBe("");
    expect(invalidTemplate.stderr).toContain("line 2, column 1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
