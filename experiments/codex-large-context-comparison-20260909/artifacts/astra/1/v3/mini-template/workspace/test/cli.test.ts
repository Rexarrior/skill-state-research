import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Keep all test fixtures inside the project directory.
const directory = mkdtempSync(join(import.meta.dir, ".cli-fixtures-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
const cli = resolve(import.meta.dir, "../src/cli.ts");
function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args]);
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
test("CLI renders UTF-8 without adding a newline", () => {
  writeFileSync(template, "Hello {{name}} — 世界");
  writeFileSync(data, JSON.stringify({ name: "<Ada>" }));
  expect(run([template, data])).toEqual({ status: 0, out: "Hello &lt;Ada&gt; — 世界", err: "" });
});
test("CLI reports usage, file, JSON, syntax, and scalar errors only on stderr", () => {
  const assertError = (args: string[], pattern: RegExp) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toMatch(pattern);
  };
  assertError([], /Usage:/);
  assertError([template, data, "extra"], /Usage:/);
  assertError([join(directory, "missing"), data], /./);
  writeFileSync(template, "prefix{{name}}");
  writeFileSync(data, "{");
  assertError([template, data], /JSON/i);
  writeFileSync(data, '{"name":{}}');
  assertError([template, data], /non-scalar/);
  writeFileSync(template, "{{else}}");
  assertError([template, data], /line 1, column 1/);
});
