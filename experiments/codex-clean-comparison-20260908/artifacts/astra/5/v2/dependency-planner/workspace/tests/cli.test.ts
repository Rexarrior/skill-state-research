import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { plan } from "../src/cli";

const task = (id: string, duration = 0, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("newly ready tasks compete lexicographically; layers and parallel timings", () => {
  expect(plan({ tasks: [task("z", 4), task("b", 3, ["a"]), task("a", 2), task("c", 1, ["z", "b"])] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 2 }, b: { start: 2, finish: 5 }, z: { start: 0, finish: 4 }, c: { start: 5, finish: 6 } },
    totalDuration: 6, criticalPath: ["a", "b", "c"],
  });
});

test("full-sequence ties, optional zero prefixes and shorter suffixes", () => {
  expect(plan({ tasks: [task("a"), task("b", 0, ["a"]), task("z", 2, ["a", "b"]), task("zz", 0, ["z"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("z"), task("a", 2, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("z"), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("special object keys and default dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, task("constructor", 1.25, ["__proto__"])] });
  expect(result.earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(1.75);
});

describe("validation", () => {
  const invalid = [null, {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
    { tasks: [task("a"), task("a")] }, ...[-1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] }))];
  for (const [i, input] of invalid.entries()) test(`reject invalid schema ${i}`, () => expect(() => plan(input)).toThrow());
});

test("deterministic concrete cycle in disconnected graph", () => {
  const tasks = [task("x"), task("c", 1, ["b"]), task("a", 1, ["c"]), task("b", 1, ["a"])];
  for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow("Cycle detected: a -> b -> c -> a");
});

test("deep graph avoids recursion limits", () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(15000);
  tasks[0].dependsOn = ["14999"];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("random DAGs match exhaustive chain enumeration", () => {
  let seed = 92741;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let trial = 0; trial < 200; trial++) {
    const ids = ["f", "a", "d", "b", "e", "c"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < 0.4)));
    let best = -1;
    let path: string[] = [];
    const visit = (chain: string[], duration: number) => {
      if (duration > best || (duration === best && comparePaths(chain, path) < 0)) { best = duration; path = chain; }
      for (const next of tasks.filter(t => t.dependsOn.includes(chain[chain.length - 1]))) visit([...chain, next.id], duration + next.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(best);
    expect(result.criticalPath).toEqual(path);
    const remaining = new Set(ids);
    for (const id of result.order) {
      expect(id).toBe([...remaining].filter(candidate => tasks.find(t => t.id === candidate)!.dependsOn.every(dep => !remaining.has(dep))).sort()[0]);
      remaining.delete(id);
    }
  }
});

test("CLI emits one JSON object or useful stderr with nonzero status", () => {
  const directory = mkdtempSync(resolve("tests", ".fixture-"));
  const file = resolve(directory, "input.json");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", resolve("src/cli.ts"), ...args]);
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a", 3)] }));
    const success = run("plan", file);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).totalDuration).toBe(3);
    for (const args of [[], ["other", file], ["plan", file, "--verbose"], ["plan", "--help"], ["plan", resolve(directory, "missing.json")]]) {
      const result = run(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString().length).toBeGreaterThan(0);
      expect(result.stdout.toString()).toBe("");
    }
    for (const contents of ["{", '{"tasks":false}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, contents);
      const result = run("plan", file);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/Invalid JSON|tasks must be an array|a -> b -> a/);
      expect(result.stdout.toString()).toBe("");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
