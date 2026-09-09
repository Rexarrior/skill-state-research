import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = mkdtempSync(resolve("tests/.cli-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
function cli(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), error: result.stderr.toString() };
}
test("CLI renders UTF-8 without additional stdout", () => {
  writeFileSync(template, "Héllo {{name}}!");
  writeFileSync(data, JSON.stringify({ name: "世界 & Bun" }));
  expect(cli([template, data])).toEqual({ code: 0, out: "Héllo 世界 &amp; Bun!", error: "" });
});
test("CLI usage, file, JSON and rendering failures go only to stderr", () => {
  writeFileSync(template, "{{name}}");
  writeFileSync(data, "{}");
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, join(directory, "missing")]]) {
    const result = cli(args);
    expect(result.code).not.toBe(0); expect(result.out).toBe(""); expect(result.error.length).toBeGreaterThan(0);
  }
  writeFileSync(data, "bad JSON");
  let result = cli([template, data]);
  expect(result.code).not.toBe(0); expect(result.out).toBe(""); expect(result.error.length).toBeGreaterThan(0);
  writeFileSync(data, '{"name":{}}');
  result = cli([template, data]);
  expect(result.code).not.toBe(0); expect(result.out).toBe(""); expect(result.error).toContain("scalar text");
  writeFileSync(template, "prefix{{#if x}}");
  result = cli([template, data]);
  expect(result.code).not.toBe(0); expect(result.out).toBe(""); expect(result.error).toContain("Unclosed");
});
