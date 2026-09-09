import { describe, expect, test } from "bun:test";
import { plan, validate } from "../src/cli";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty input", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready queue differs from dependency layers; disconnected tasks", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 5, ["b", "z"])] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 9 } },
    totalDuration: 9, criticalPath: ["a", "b", "c"],
  });
});

test("full sequence ties and zero-duration prefixes/suffixes", () => {
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("z", 3, ["a", "b"]), task("zz", 0, ["z"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 1), task("b", 1), task("d", 1, ["a"]), task("c", 1, ["b"])] }).criticalPath).toEqual(["a", "d"]);
});

test("special object keys and omitted dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, task("constructor", 0.25, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});

describe("validation", () => {
  for (const input of [null, [], {}, { tasks: null }, { tasks: [null] }, { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] }))]) {
    test(`rejects ${JSON.stringify(input)}`, () => expect(() => validate(input)).toThrow());
  }
});

test("cycle is concrete and independent of input ordering", () => {
  const tasks = [task("z", 1, ["b"]), task("b", 1, ["a"]), task("a", 1, ["b"]), task("free")];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Cycle detected: a -> b -> a");
});

test("long chains do not overflow the call stack", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i).padStart(5, "0"), 1, i ? [String(i - 1).padStart(5, "0")] : []));
  expect(plan({ tasks }).criticalPath.length).toBe(tasks.length);
  tasks[0].dependsOn = [tasks[tasks.length - 1].id];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("seeded DAGs agree with exhaustive chain and scheduling oracle", () => {
  let seed = 12345;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let run = 0; run < 300; run++) {
    const ids = ["z", "a", "q", "b", "c", "y", "d"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.4)));
    const paths: { ids: string[]; duration: number }[] = [];
    const walk = (path: string[], duration: number) => {
      paths.push({ ids: path, duration });
      for (const next of tasks.filter(t => t.dependsOn.includes(path[path.length - 1]))) walk([...path, next.id], duration + next.duration);
    };
    for (const t of tasks) walk([t.id], t.duration);
    paths.sort((a, b) => b.duration - a.duration || comparePaths(a.ids, b.ids));
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(paths[0].duration);
    expect(result.criticalPath).toEqual(paths[0].ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      done.add(id);
    }
    for (const t of tasks) {
      const start = Math.max(0, ...t.dependsOn.map(d => result.earliest[d].finish));
      expect(result.earliest[t.id]).toEqual({ start, finish: start + t.duration });
      const depth = Math.max(-1, ...t.dependsOn.map(d => result.layers.findIndex(layer => layer.includes(d)))) + 1;
      expect(result.layers[depth]).toContain(t.id);
    }
    for (const layer of result.layers) expect(layer).toEqual([...layer].sort());
    expect(plan({ tasks })).toEqual(result);
  }
});

test("CLI success and failures use the correct streams and exit status", () => {
  const dir = join(import.meta.dir, `.fixtures-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "input.json");
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args]);
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a", 2)] }));
    const success = cli("plan", file);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).totalDuration).toBe(2);
    for (const args of [[], ["help"], ["other", file], ["plan"], ["plan", file, "--verbose"], ["plan", "--help"], ["plan", join(dir, "missing.json")]]) {
      const result = cli(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const [text, message] of [["{", "Invalid JSON"], ['{"tasks":null}', "tasks"], [JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] }), "a -> b -> a"]]) {
      writeFileSync(file, text);
      const result = cli("plan", file);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(message);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
