import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = mkdtempSync(join(import.meta.dir, ".cli-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "cli.ts"), ...args]);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("CLI preserves UTF-8 and emits only rendered text without a newline", () => {
  const template = join(directory, "template.txt");
  const data = join(directory, "data.json");
  writeFileSync(template, "Привет {{name}}!\n終");
  writeFileSync(data, JSON.stringify({ name: "é & 😀" }));
  expect(run(template, data)).toEqual({ code: 0, stdout: "Привет é &amp; 😀!\n終", stderr: "" });
});

test("CLI errors have nonzero exit status, stderr, and no stdout", () => {
  const template = join(directory, "errors.txt");
  const data = join(directory, "errors.json");
  writeFileSync(template, "prefix {{value}}");
  writeFileSync(data, '{"value":{}}');
  const cases = [run(), run(template), run(template, data, "extra"), run(join(directory, "missing"), data), run(template, data)];
  writeFileSync(data, "invalid json");
  cases.push(run(template, data));
  writeFileSync(data, "{}");
  writeFileSync(template, "prefix {{#if value}}");
  cases.push(run(template, data));
  for (const result of cases) {
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
