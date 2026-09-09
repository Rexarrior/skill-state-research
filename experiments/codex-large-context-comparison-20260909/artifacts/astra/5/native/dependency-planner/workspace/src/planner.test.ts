import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plan, type Task } from "./planner";

test("empty plan", () => {
  expect(plan({ tasks: [] })).toEqual({
    order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
  });
});

test("ready queue, dependency layers, disconnected tasks and parallel timing", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 2 },
    { id: "b", duration: 3 },
    { id: "a", duration: 4, dependsOn: ["b"] },
    { id: "c", duration: 1, dependsOn: ["z", "a"] },
  ] })).toEqual({
    order: ["b", "a", "z", "c"],
    layers: [["b", "z"], ["a"], ["c"]],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 7 },
      z: { start: 0, finish: 2 }, c: { start: 7, finish: 8 } },
    totalDuration: 8, criticalPath: ["b", "a", "c"],
  });
});

test("critical ties compare full sequences, including prefix alternatives", () => {
  const tasks = [
    { id: "a", duration: 1 },
    { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 1, dependsOn: ["a", "b"] },
  ];
  expect(plan({ tasks }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "z", duration: 1 },
    { id: "b", duration: 1, dependsOn: ["z"] },
    { id: "y", duration: 1, dependsOn: ["a"] },
    { id: "end", duration: 1, dependsOn: ["b", "y"] },
  ] }).criticalPath).toEqual(["a", "y", "end"]);
});

test("zero duration chains and arbitrary safe ids", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
  const result = plan({ tasks: [
    { id: "__proto__", duration: 0.5 },
    { id: "constructor", duration: 1.25, dependsOn: ["__proto__"] },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(1.75);
});

describe("schema errors", () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 3, duration: 1 }] },
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["missing"], ["a"], ["b", "b"]].map(dependsOn => ({
      tasks: [{ id: "a", duration: 1, dependsOn }, { id: "b", duration: 1 }],
    })),
  ];
  for (let i = 0; i < invalid.length; i++) {
    test(`invalid schema ${i}`, () => expect(() => plan(invalid[i])).toThrow());
  }
});

test("cycle is concrete and deterministic across input permutations", () => {
  const tasks = [
    { id: "c", duration: 0, dependsOn: ["b", "a"] },
    { id: "b", duration: 0, dependsOn: ["c"] },
    { id: "a", duration: 0, dependsOn: ["b"] },
    { id: "free", duration: 1 },
  ];
  expect(() => plan({ tasks })).toThrow("Dependency cycle: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.toReversed().map(t => ({ ...t, dependsOn: t.dependsOn?.toReversed() })) }))
    .toThrow("Dependency cycle: a -> b -> c -> a");
});

test("rejects duration overflow", () => {
  expect(() => plan({ tasks: [
    { id: "a", duration: Number.MAX_VALUE },
    { id: "b", duration: Number.MAX_VALUE, dependsOn: ["a"] },
  ] })).toThrow("overflow");
});

test("seeded DAGs agree with exhaustive dependency chain enumeration", () => {
  let seed = 9271;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 200; trial++) {
    const ids = ["z", "a", "q", "b", "d", "c", "x"];
    const tasks: Task[] = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4),
      dependsOn: ids.slice(0, i).filter(() => random() < 0.35) }));
    const chains: { ids: string[]; duration: number }[] = [];
    function enumerate(path: string[], duration: number) {
      chains.push({ ids: path, duration });
      for (const task of tasks) {
        if (task.dependsOn.includes(path[path.length - 1])) enumerate([...path, task.id], duration + task.duration);
      }
    }
    for (const task of tasks) enumerate([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || compare(a.ids, b.ids));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].ids);
    const visited = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => !visited.has(t.id) && t.dependsOn.every(d => visited.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      visited.add(id);
      const ending = chains.filter(c => c.ids.at(-1) === id);
      expect(result.earliest[id].finish).toBe(Math.max(...ending.map(c => c.duration)));
      expect(result.layers.findIndex(layer => layer.includes(id))).toBe(Math.max(...ending.map(c => c.ids.length)) - 1);
    }
    expect(plan({ tasks: tasks.toReversed().map(t => ({ ...t, dependsOn: t.dependsOn.toReversed() })) })).toEqual(result);
  }
});

const fixtureDir = mkdtempSync(join(import.meta.dir, ".test-input-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
function run(args: string[]) {
  return Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "cli.ts"), ...args]);
}

test("CLI emits exactly one JSON object", () => {
  const file = join(fixtureDir, "valid.json");
  writeFileSync(file, '{"tasks":[{"id":"build","duration":3}]}');
  const result = run(["plan", file]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString().trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout.toString()).totalDuration).toBe(3);
});

test("CLI failures go to stderr and exit nonzero", () => {
  const badJson = join(fixtureDir, "bad.json");
  const badSchema = join(fixtureDir, "schema.json");
  const cycle = join(fixtureDir, "cycle.json");
  writeFileSync(badJson, "{");
  writeFileSync(badSchema, '{"tasks":null}');
  writeFileSync(cycle, JSON.stringify({ tasks: [
    { id: "b", duration: 1, dependsOn: ["a"] },
    { id: "a", duration: 1, dependsOn: ["b"] },
  ] }));
  const cases: [string[], string][] = [
    [[], "Usage"], [["other", badJson], "Usage"], [["plan"], "Usage"],
    [["plan", "--help"], "Usage"], [["plan", badJson, "--foo"], "Usage"],
    [["plan", join(fixtureDir, "missing.json")], "Cannot read"],
    [["plan", badJson], "Invalid JSON"], [["plan", badSchema], "tasks"],
    [["plan", cycle], "a -> b -> a"],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(message);
  }
});
