import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = mkdtempSync(join(import.meta.dir, ".cli-fixture-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("CLI reads UTF-8 and emits exact output", () => {
  writeFileSync(template, "Hello {{name}}!\n\t{{{name}}}");
  writeFileSync(data, JSON.stringify({ name: "世界 & café" }));
  expect(run([template, data])).toEqual({ code: 0, out: "Hello 世界 &amp; café!\n\t世界 & café", err: "" });
});

test("CLI failures use stderr and emit no partial output", () => {
  writeFileSync(template, "prefix {{x}}");
  writeFileSync(data, JSON.stringify({ x: {} }));
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, data]]) {
    const result = run(args);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err.length).toBeGreaterThan(0);
  }
  writeFileSync(data, "{invalid JSON");
  const result = run([template, data]);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe("");
  expect(result.err.length).toBeGreaterThan(0);
});
