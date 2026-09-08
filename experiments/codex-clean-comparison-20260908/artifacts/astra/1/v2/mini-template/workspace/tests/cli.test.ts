import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = mkdtempSync(join(import.meta.dir, ".cli-fixture-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
const cli = join(import.meta.dir, "../src/cli.ts");
function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("CLI reads UTF-8 and emits exact output", () => {
  writeFileSync(template, "Hello {{name}}!\n尾");
  writeFileSync(data, JSON.stringify({ name: "É<&" }));
  expect(run([template, data])).toEqual({ code: 0, out: "Hello É&lt;&amp;!\n尾", err: "" });
});

test("CLI reports usage, file, JSON, syntax and value errors without stdout", () => {
  writeFileSync(template, "{{name}}");
  writeFileSync(data, "{}");
  const results = [run([]), run([template]), run([template, data, "extra"]), run([join(directory, "missing"), data])];
  writeFileSync(data, "invalid json");
  results.push(run([template, data]));
  writeFileSync(data, "{}");
  writeFileSync(template, "prefix{{#if name}}");
  results.push(run([template, data]));
  writeFileSync(template, "prefix{{this}}");
  results.push(run([template, data]));
  for (const result of results) {
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err.length).toBeGreaterThan(0);
  }
});
