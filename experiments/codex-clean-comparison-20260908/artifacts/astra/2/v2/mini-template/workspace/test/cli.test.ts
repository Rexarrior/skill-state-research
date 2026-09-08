import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(import.meta.dir, ".cli-fixtures-"));
const template = join(directory, "template.txt");
const data = join(directory, "data.json");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../src/cli.ts"), ...args]);
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
test("CLI renders UTF-8 with exact stdout", () => {
  writeFileSync(template, "Привет {{name}}!\n");
  writeFileSync(data, JSON.stringify({ name: "世界 & everyone" }));
  expect(run([template, data])).toEqual({ code: 0, stdout: "Привет 世界 &amp; everyone!\n", stderr: "" });
  writeFileSync(template, "");
  expect(run([template, data])).toEqual({ code: 0, stdout: "", stderr: "" });
});
test("CLI errors use stderr and nonzero status", () => {
  writeFileSync(template, "{{else}}");
  writeFileSync(data, "{}");
  for (const args of [[], [template], [template, data, "extra"], [join(directory, "missing"), data], [template, data]]) {
    const result = run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
  writeFileSync(data, "invalid JSON");
  const result = run([template, data]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.length).toBeGreaterThan(0);
});
