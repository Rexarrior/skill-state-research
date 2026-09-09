import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, validate } from "../src/cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("parallel scheduling, layers, disconnected components and dynamic ready ordering", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 4, ["b", "z"])] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 8 } },
    totalDuration: 8, criticalPath: ["a", "b", "c"],
  });
});

test("empty graph and special object keys", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [task("__proto__"), task("constructor", 2, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
  expect(validate({ tasks: [{ id: "a", duration: 0 }] })[0]!.dependsOn).toEqual([]);
});

test("full-sequence ties, zero prefixes and shorter equal-duration chains", () => {
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("z", 5, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("a", 5), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["z"]), task("a", 2), task("c", 3, ["a"])] }).criticalPath).toEqual(["a", "c"]);
});

describe("schema validation", () => {
  const bad: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
    { tasks: [task("a"), task("a")] }, { tasks: [task("a", -1)] }, { tasks: [task("a", Infinity)] },
    { tasks: [task("a", NaN)] }, { tasks: [{ id: "a", duration: "1" }] },
    { tasks: [{ id: 1, duration: 1 }] }, { tasks: [{ id: "a" }] },
    { tasks: [{ id: "a", duration: 1, dependsOn: null }] },
    { tasks: [{ id: "a", duration: 1, dependsOn: [1] }] },
    { tasks: [task("a", 1, ["b"])] }, { tasks: [task("a", 1, ["a"])] },
    { tasks: [task("a"), task("b", 1, ["a", "a"])] }];
  for (const [index, input] of bad.entries()) test(`rejects invalid schema ${index}`, () => expect(() => plan(input)).toThrow());
});

test("deterministic concrete cycle independent of input order", () => {
  const tasks = [task("c", 1, ["a"]), task("a", 1, ["b"]), task("b", 1, ["c"]), task("free")];
  expect(() => plan({ tasks })).toThrow("Dependency cycle: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Dependency cycle: a -> b -> c -> a");
});

test("deep graph does not depend on call stack size", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0]!.dependsOn = ["11999"];
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("random DAGs match exhaustive chain and scheduling oracles", () => {
  let seed = 731;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 250; iteration++) {
    const ids = ["d", "b", "g", "a", "f", "c", "e"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.4)));
    const result = plan({ tasks: [...tasks].reverse() });
    const paths: { ids: string[]; sum: number }[] = [];
    function walk(ids: string[], sum: number) {
      paths.push({ ids, sum });
      for (const next of tasks.filter(t => t.dependsOn.includes(ids.at(-1)!))) walk([...ids, next.id], sum + next.duration);
    }
    for (const t of tasks) walk([t.id], t.duration);
    const max = Math.max(...paths.map(p => p.sum));
    const best = paths.filter(p => p.sum === max).sort((a, b) => comparePaths(a.ids, b.ids))[0]!;
    expect(result.totalDuration).toBe(max);
    expect(result.criticalPath).toEqual(best.ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      done.add(id);
      const t = tasks.find(t => t.id === id)!;
      const start = Math.max(0, ...t.dependsOn.map(d => result.earliest[d]!.finish));
      expect(result.earliest[id]).toEqual({ start, finish: start + t.duration });
      const layer = t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map(d => result.layers.findIndex(l => l.includes(d)))) : 0;
      expect(result.layers[layer]).toContain(id);
    }
    expect(plan({ tasks })).toEqual(result);
  }
});

test("CLI stdout, stderr, exit codes and unsupported arguments", () => {
  mkdirSync("tests/.tmp", { recursive: true });
  const dir = mkdtempSync("tests/.tmp/run-");
  const file = join(dir, "input.json");
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args]);
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("build", 3)] }));
    const success = run("plan", file);
    expect(success.code).toBe(0);
    expect(success.err).toBe("");
    expect(success.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.out).totalDuration).toBe(3);
    for (const args of [[], ["other", file], ["plan"], ["plan", file, "--help"], ["plan", "--help"], ["plan", join(dir, "missing.json")]]) {
      const result = run(...args);
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err.length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":[{"id":"a","duration":1e999}]}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, text);
      const result = run("plan", file);
      expect(result.code).not.toBe(0);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/Invalid JSON|finite non-negative|a -> b -> a/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
