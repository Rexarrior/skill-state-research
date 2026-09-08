import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const project = join(import.meta.dir, "..");
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("CLI exact UTF-8 output and error handling", async () => {
  const dir = await mkdtemp(join(project, ".cli-test-"));
  try {
    const template = join(dir, "template.txt");
    const data = join(dir, "data.json");
    await writeFile(template, "Hi {{name}} 🌍");
    await writeFile(data, JSON.stringify({ name: "é<&" }));
    expect(await run([template, data])).toEqual({ stdout: "Hi é&lt;&amp; 🌍", stderr: "", code: 0 });
    await writeFile(data, "invalid json");
    const invalid = await run([template, data]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr.length).toBeGreaterThan(0);
    await writeFile(data, "{}");
    await writeFile(template, "prefix{{else}}");
    const syntax = await run([template, data]);
    expect(syntax.code).not.toBe(0);
    expect(syntax.stdout).toBe("");
    expect(syntax.stderr).toContain("line 1, column 7");
    for (const args of [[], [template], [template, data, "extra"], [join(dir, "missing"), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
