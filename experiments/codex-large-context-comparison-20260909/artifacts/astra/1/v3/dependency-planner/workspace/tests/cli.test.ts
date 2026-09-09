import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { plan } from "../src/cli";

test("empty plan", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("frontier ordering, dependency layers and parallel timing", () => {
  const tasks = [
    { id: "z", duration: 9 },
    { id: "b", duration: 2 },
    { id: "a", duration: 3, dependsOn: ["b"] },
    { id: "c", duration: 1, dependsOn: ["z", "a"] },
  ];
  const result = plan({ tasks });
  expect(result).toEqual({
    order: ["b", "a", "z", "c"], layers: [["b", "z"], ["a"], ["c"]],
    earliest: { b: { start: 0, finish: 2 }, a: { start: 2, finish: 5 }, z: { start: 0, finish: 9 }, c: { start: 9, finish: 10 } },
    totalDuration: 10, criticalPath: ["z", "c"],
  });
  expect(plan({ tasks: tasks.toReversed() })).toEqual(result);
});

test("special property names are ordinary ids", () => {
  const result = plan({ tasks: [
    { id: "__proto__", duration: 1 },
    { id: "constructor", duration: 2, dependsOn: ["__proto__"] },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

test("ties compare full paths and handle zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 1 }, { id: "a", duration: 1 },
    { id: "b", duration: 1, dependsOn: ["z"] },
    { id: "y", duration: 1, dependsOn: ["a"] },
    { id: "end", duration: 1, dependsOn: ["b", "y"] },
  ] }).criticalPath).toEqual(["a", "y", "end"]);
  expect(plan({ tasks: [
    { id: "a", duration: 0 }, { id: "b", duration: 2, dependsOn: ["a"] },
    { id: "c", duration: 0, dependsOn: ["b"] },
  ] }).criticalPath).toEqual(["a", "b"]);
  expect(plan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 2, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
});

describe("validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: null }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    ...[undefined, -1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["b", "b"], ["missing"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  for (const [index, input] of invalid.entries()) test(`rejects invalid schema ${index}`, () => expect(() => plan(input)).toThrow());
});

test("deterministic concrete cycle in a disconnected graph", () => {
  const tasks = [
    { id: "c", duration: 0, dependsOn: ["b"] },
    { id: "b", duration: 0, dependsOn: ["a", "c"] },
    { id: "a", duration: 0, dependsOn: ["b"] },
    { id: "free", duration: 1 },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: tasks.toReversed() })).toThrow("Cycle detected: a -> b -> a");
});

test("generated DAGs agree with exhaustive chain enumeration", () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 200; trial++) {
    const ids = ["f", "a", "d", "b", "e", "c"];
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 3), dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    const chains: { path: string[]; duration: number }[] = [];
    const visit = (path: string[], duration: number) => {
      chains.push({ path, duration });
      for (const child of tasks.filter(task => task.dependsOn.includes(path.at(-1)!))) visit([...path, child.id], duration + child.duration);
    };
    for (const task of tasks) visit([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || comparePaths(a.path, b.path));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].path);
    const pending = new Set(ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(task => pending.has(task.id) && task.dependsOn.every(dep => done.has(dep))).map(task => task.id).sort();
      expect(id).toBe(ready[0]);
      pending.delete(id);
      done.add(id);
      const task = tasks.find(task => task.id === id)!;
      expect(result.earliest[id].start).toBe(Math.max(0, ...task.dependsOn.map(dep => result.earliest[dep].finish)));
      expect(result.layers.findIndex(layer => layer.includes(id))).toBe(Math.max(-1, ...task.dependsOn.map(dep => result.layers.findIndex(layer => layer.includes(dep)))) + 1);
    }
  }
});

test("CLI emits one JSON object and useful failures without stdout", () => {
  const directory = resolve(`tests/.fixtures-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const input = resolve(directory, "input.json");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: resolve(import.meta.dir, "..") });
  try {
    writeFileSync(input, '{"tasks":[{"id":"a","duration":1.5}]}');
    const success = run(["plan", input]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).totalDuration).toBe(1.5);
    for (const args of [[], ["unknown", input], ["plan", input, "--flag"], ["plan", "--help"], ["plan", `${input}.missing`]]) {
      const failure = run(args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe("");
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":false}', '{"tasks":[{"id":"a","duration":1e999}]}', '{"tasks":[{"id":"a","duration":0,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}']) {
      writeFileSync(input, text);
      const failure = run(["plan", input]);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe("");
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
