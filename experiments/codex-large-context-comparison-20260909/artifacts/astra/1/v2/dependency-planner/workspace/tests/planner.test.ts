import { describe, expect, test } from "bun:test";
import { plan } from "../src/planner";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty input", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("newly ready tasks compete lexicographically; layers differ from order", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1)] })).toEqual({
    order: ["a", "b", "z"], layers: [["a", "z"], ["b"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 } },
    totalDuration: 4, criticalPath: ["a", "b"],
  });
});

test("full path ties, zero durations, disconnected components", () => {
  expect(plan({ tasks: [task("a"), task("z", 2, ["a"]), task("b"), task("c", 2, ["b"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("c", 2, ["a", "b"]), task("d", 0, ["c"])] }).criticalPath).toEqual(["a", "b", "c"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("defaults, fractions, and prototype-like ids", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, task("constructor", 0.25, ["__proto__"])] });
  expect(result.earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__.finish).toBe(0.5);
});

describe("validation", () => {
  const invalid = [null, [], {}, { tasks: null }, { tasks: [null] },
    { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, NaN, Infinity, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["missing"], ["a"], ["b", "b"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }, task("b")] }))];
  for (const [i, input] of invalid.entries()) test(`invalid schema ${i}`, () => expect(() => plan(input)).toThrow());
});

test("deterministic concrete cycle", () => {
  const tasks = [task("b", 1, ["a"]), task("a", 1, ["b"]), task("z")];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Cycle detected: a -> b -> a");
});

test("exhaustive four-node DAGs match enumerated paths", () => {
  const ids = ["d", "a", "c", "b"];
  const edges: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) edges.push([i, j]);
  const sequenceCompare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let mask = 0; mask < 64; mask++) for (let durations = 0; durations < 16; durations++) {
    const tasks = ids.map((id, i) => task(id, (durations >> i) & 1));
    edges.forEach(([from, to], bit) => { if (mask & (1 << bit)) tasks[to].dependsOn.push(ids[from]); });
    const paths: { ids: string[]; weight: number }[] = [];
    const visit = (path: string[], weight: number, index: number) => {
      const nextPath = [...path, ids[index]];
      const nextWeight = weight + tasks[index].duration;
      paths.push({ ids: nextPath, weight: nextWeight });
      tasks.forEach((child, j) => { if (child.dependsOn.includes(ids[index])) visit(nextPath, nextWeight, j); });
    };
    ids.forEach((_, i) => visit([], 0, i));
    paths.sort((a, b) => b.weight - a.weight || sequenceCompare(a.ids, b.ids));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(paths[0].weight);
    expect(result.criticalPath).toEqual(paths[0].ids);
    expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
    const remaining = new Set(ids);
    for (const id of result.order) {
      const ready = tasks.filter(t => remaining.has(t.id) && t.dependsOn.every(dep => !remaining.has(dep))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      remaining.delete(id);
    }
  }
});

test("long chains avoid call-stack overflow", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).criticalPath.length).toBe(12000);
  tasks[0].dependsOn = ["11999"];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("CLI succeeds with one JSON line and fails cleanly", () => {
  const directory = join(import.meta.dir, `.fixtures-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const valid = join(directory, "valid.json");
  const invalid = join(directory, "invalid.json");
  const schema = join(directory, "schema.json");
  const cyclic = join(directory, "cycle.json");
  try {
    writeFileSync(valid, JSON.stringify({ tasks: [task("a")] }));
    writeFileSync(invalid, "{");
    writeFileSync(schema, '{"tasks":false}');
    writeFileSync(cyclic, JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] }));
    const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args]);
    const success = run(["plan", valid]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).criticalPath).toEqual(["a"]);
    for (const args of [[], ["other", valid], ["plan"], ["plan", "--help"], ["plan", valid, "--extra"], ["plan", invalid], ["plan", schema], ["plan", cyclic], ["plan", join(directory, "missing")]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
