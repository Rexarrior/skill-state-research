import { expect, test } from "bun:test";
import { plan } from "../src/cli";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready queue, layers, weighted diamond and disconnected tasks", () => {
  const result = plan({ tasks: [task("z", 2), task("b", 4, ["a"]), task("a", 2), task("c", 1, ["a"]), task("d", 3, ["b", "c"])] });
  expect(result).toEqual({
    order: ["a", "b", "c", "d", "z"], layers: [["a", "z"], ["b", "c"], ["d"]],
    earliest: { a: { start: 0, finish: 2 }, b: { start: 2, finish: 6 }, c: { start: 2, finish: 3 }, d: { start: 6, finish: 9 }, z: { start: 0, finish: 2 } },
    totalDuration: 9, criticalPath: ["a", "b", "d"],
  });
});

test("full sequence ties and zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("z", 1, ["a", "b"]), task("a", 2), task("b", 2)] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("z", 3, ["a", "b"]), task("zz", 0, ["z"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("special object keys and optional dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, task("constructor", 1, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});

test("schema rejection", () => {
  for (const input of [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, Infinity, NaN, "3", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] }))]) {
    expect(() => plan(input)).toThrow();
  }
});

test("deterministic concrete cycle", () => {
  const tasks = [task("c", 1, ["b"]), task("b", 1, ["a"]), task("a", 1, ["c"]), task("free")];
  expect(() => plan({ tasks })).toThrow("a -> b -> c -> a");
  expect(() => plan({ tasks: [...tasks].reverse() })).toThrow("a -> b -> c -> a");
});

test("deep graph uses no recursive traversal", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(`t${i}`, 1, i ? [`t${i - 1}`] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0].dependsOn = ["t11999"];
  expect(() => plan({ tasks })).toThrow("Cycle detected");
});

test("CLI output, JSON errors, file errors, commands and flags", () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-"));
  const file = join(dir, "input.json");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a")] }));
    const good = run(["plan", file]);
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe("");
    expect(good.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(good.stdout.toString()).criticalPath).toEqual(["a"]);
    for (const args of [[], ["other", file], ["plan"], ["plan", file, "--x"], ["plan", "--x"], ["plan", join(dir, "missing")]]) {
      const bad = run(args);
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stdout.toString()).toBe("");
      expect(bad.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":null}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, text);
      const bad = run(["plan", file]);
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stdout.toString()).toBe("");
      expect(bad.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
