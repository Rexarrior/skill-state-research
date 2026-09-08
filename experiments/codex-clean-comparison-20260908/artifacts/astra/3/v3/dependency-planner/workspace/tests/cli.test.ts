import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = mkdtempSync(join(import.meta.dir, ".fixtures-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const fixture = (name: string, text: string) => {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
};
const valid = fixture("valid.json", '{"tasks":[{"id":"build","duration":3,"dependsOn":["lint"]},{"id":"lint","duration":1}]}');
const run = (...args: string[]) => {
  const child = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../src/cli.ts"), ...args]);
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
};
test("CLI emits exactly one JSON object", () => {
  const result = run("plan", valid);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({ order: ["lint", "build"], layers: [["lint"], ["build"]], earliest: { lint: { start: 0, finish: 1 }, build: { start: 1, finish: 4 } }, totalDuration: 4, criticalPath: ["lint", "build"] });
});
for (const args of [[], ["other", valid], ["plan"], ["plan", "--help"], ["plan", valid, "--unknown"]]) {
  test(`reject arguments ${JSON.stringify(args)}`, () => {
    const result = run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });
}
for (const [name, text, message] of [
  ["malformed.json", "{", "Invalid JSON"],
  ["schema.json", '{"tasks":[{"id":"a","duration":-1}]}', "duration"],
  ["cycle.json", '{"tasks":[{"id":"b","duration":0,"dependsOn":["a"]},{"id":"a","duration":0,"dependsOn":["b"]}]}', "a -> b -> a"],
]) test(`CLI rejects ${name}`, () => {
  const result = run("plan", fixture(name, text));
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
});
test("unreadable input", () => {
  const result = run("plan", join(directory, "missing.json"));
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Cannot read input");
});
