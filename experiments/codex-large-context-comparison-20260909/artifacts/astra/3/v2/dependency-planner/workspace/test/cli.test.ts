import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(import.meta.dir, ".fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name: string, content: string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};
const run = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args]);
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

test("CLI emits exactly one JSON object", () => {
  const result = run("plan", fixture("valid.json", '{"tasks":[{"id":"a","duration":0.5}]}'));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout).totalDuration).toBe(0.5);
});

test("CLI rejects invalid JSON, schemas, cycles, and missing files", () => {
  for (const [name, text, message] of [
    ["bad.json", "{", "Invalid JSON"],
    ["schema.json", '{"tasks":false}', "tasks array"],
    ["cycle.json", '{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":1,"dependsOn":["a"]}]}', "a -> b -> a"],
    ["infinite.json", '{"tasks":[{"id":"a","duration":1e400}]}', "finite"],
  ]) {
    const result = run("plan", fixture(name, text));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  }
  expect(run("plan", join(dir, "missing.json")).code).not.toBe(0);
});

test("CLI rejects unknown commands, flags, and extra arguments", () => {
  for (const args of [[], ["help"], ["plan"], ["other", "input.json"], ["plan", "--help"], ["plan", "input.json", "--foo"]]) {
    const result = run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  }
});
