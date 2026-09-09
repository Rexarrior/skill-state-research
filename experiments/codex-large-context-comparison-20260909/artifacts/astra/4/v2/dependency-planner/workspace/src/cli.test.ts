import { test, expect } from "bun:test";
import { plan } from "./cli";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});
test("ready queue, layers, parallel timing and disconnected components", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 4, ["b", "z"])] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 8 } },
    totalDuration: 8, criticalPath: ["a", "b", "c"],
  });
});
test("full sequence ties, zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("z", 2, ["a"]), task("a", 0), task("b", 2), task("c", 0, ["z"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("a", 0, ["z"]), task("z", 0)] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a"), task("z", 1, ["a"]), task("b", 1, ["a"])] }).criticalPath).toEqual(["a", "b"]);
});
test("decimal arithmetic follows forward timing", () => {
  const result = plan({ tasks: [task("a", .1), task("b", .2, ["a"]), task("c", .3, ["b"]), task("d", .6)] });
  expect(result.criticalPath).toEqual(["a", "b", "c"]);
  expect(result.totalDuration).toBe(.1 + .2 + .3);
});
test("special object keys and omitted dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0 }, task("constructor", 1, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});
test("schema validation", () => {
  for (const input of [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
    { tasks: [task("a"), task("a")] }, ...[-1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["missing"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 0, dependsOn }] }))]) {
    expect(() => plan(input)).toThrow();
  }
});
test("deterministic concrete cycle", () => {
  const tasks = [task("z"), task("b", 1, ["a"]), task("a", 1, ["b"])];
  for (const permutation of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: permutation })).toThrow("a -> b -> a");
});
test("long chains avoid recursion limits", () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(15000);
  tasks[0]!.dependsOn = ["14999"];
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});
test("CLI JSON output and failure exit status", () => {
  const dir = mkdtempSync(join(process.cwd(), ".cli-test-"));
  const file = join(dir, "input.json");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a")] }));
    const ok = run(["plan", file]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toBe("");
    expect(JSON.parse(ok.stdout.toString()).order).toEqual(["a"]);
    for (const args of [[], ["other", file], ["plan"], ["plan", file, "--help"], ["plan", "--help"], ["plan", join(dir, "missing")]]) {
      const failure = run(args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stderr.length).toBeGreaterThan(0);
      expect(failure.stdout.length).toBe(0);
    }
    for (const content of ["{", '{"tasks":null}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, content);
      const failure = run(["plan", file]);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stderr.length).toBeGreaterThan(0);
      expect(failure.stdout.length).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
