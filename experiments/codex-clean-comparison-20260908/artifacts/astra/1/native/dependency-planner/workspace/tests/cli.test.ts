import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Keep all test fixtures inside the project directory.
const directory = mkdtempSync(join(import.meta.dir, ".fixtures-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let next = 0;
function fixture(contents: string): string {
  const path = join(directory, `${next++}.json`);
  writeFileSync(path, contents);
  return path;
}
function run(args: string[]) {
  const child = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("CLI prints exactly one JSON object and no stderr", () => {
  const result = run(["plan", fixture('{"tasks":[{"id":"a","duration":2}]}')]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    order: ["a"], layers: [["a"]], earliest: { a: { start: 0, finish: 2 } }, totalDuration: 2, criticalPath: ["a"],
  });
});

test("CLI rejects bad commands, flags, arity, files, JSON, and schema", () => {
  const valid = fixture('{"tasks":[]}');
  const cases: [string[], string][] = [
    [[], "command"], [["other", valid], "command"], [["plan"], "input file"],
    [["plan", valid, valid], "input file"], [["plan", valid, "--verbose"], "flag"],
    [["--help"], "flag"], [["plan", join(directory, "missing.json")], "Cannot read"],
    [["plan", fixture("{")], "Invalid JSON"], [["plan", fixture("null")], "tasks"],
    [["plan", fixture('{"tasks":[{"id":"a","duration":1e999}]}')], "finite"],
    [["plan", fixture('{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":1,"dependsOn":["a"]}]}')], "a -> b -> a"],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  }
});
