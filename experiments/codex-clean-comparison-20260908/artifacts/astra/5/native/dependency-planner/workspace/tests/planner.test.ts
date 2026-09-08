import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, type Task } from "../src/planner";

test("diamond, disconnected component, and fractional durations", () => {
  expect(plan({ tasks: [
    { id: "end", duration: 1, dependsOn: ["right", "left"] },
    { id: "right", duration: 3, dependsOn: ["start"] },
    { id: "alone", duration: 0.5 },
    { id: "start", duration: 2 },
    { id: "left", duration: 3, dependsOn: ["start"] },
  ] })).toEqual({
    order: ["alone", "start", "left", "right", "end"],
    layers: [["alone", "start"], ["left", "right"], ["end"]],
    earliest: { alone: { start: 0, finish: 0.5 }, start: { start: 0, finish: 2 }, left: { start: 2, finish: 5 }, right: { start: 2, finish: 5 }, end: { start: 5, finish: 6 } },
    totalDuration: 6,
    criticalPath: ["start", "left", "end"],
  });
});

test("newly ready tasks compete with previously ready tasks", () => {
  const result = plan({ tasks: [{ id: "z", duration: 0 }, { id: "b", duration: 0 }, { id: "a", duration: 0, dependsOn: ["b"] }] });
  expect(result.order).toEqual(["b", "a", "z"]);
  expect(result.layers).toEqual([["b", "z"], ["a"]]);
  expect(result.criticalPath).toEqual(["a"]);
});

test("empty graph and ids matching object prototype properties", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, { id: "constructor", duration: 1, dependsOn: ["__proto__"] }] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

test("critical ties compare full sequences, including zero-duration prefixes", () => {
  const result = plan({ tasks: [
    { id: "a", duration: 1 },
    { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 1, dependsOn: ["a", "b"] },
    { id: "tail", duration: 0, dependsOn: ["z"] },
  ] });
  expect(result.criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 1, dependsOn: ["a"] }] }).criticalPath).toEqual(["a", "b"]);
});

describe("validation", () => {
  const cases: [unknown, RegExp][] = [
    [null, /tasks array/], [{}, /tasks array/], [{ tasks: {} }, /tasks array/],
    [{ tasks: [null] }, /must be an object/],
    [{ tasks: [{ id: "", duration: 1 }] }, /non-empty string/],
    [{ tasks: [{ id: 1, duration: 1 }] }, /non-empty string/],
    [{ tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] }, /Duplicate/],
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => [{ tasks: [{ id: "a", duration }] }, /finite non-negative/] as [unknown, RegExp]),
    ...[null, "a", [1]].map(dependsOn => [{ tasks: [{ id: "a", duration: 1, dependsOn }] }, /array of strings/] as [unknown, RegExp]),
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["b", "b"] }] }, /duplicate ids/],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["a"] }] }, /itself/],
    [{ tasks: [{ id: "a", duration: 1, dependsOn: ["missing"] }] }, /unknown dependency/],
  ];
  for (const [index, [input, message]] of cases.entries()) {
    test(`invalid schema ${index}`, () => expect(() => plan(input)).toThrow(message));
  }
});

test("cycle reporting is concrete and invariant under input permutation", () => {
  const tasks = [
    { id: "c", duration: 1, dependsOn: ["b", "a"] },
    { id: "b", duration: 1, dependsOn: ["c"] },
    { id: "a", duration: 1, dependsOn: ["b"] },
    { id: "isolated", duration: 1 },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.reverse().map(task => ({ ...task, dependsOn: task.dependsOn?.reverse() })) })).toThrow("Cycle detected: a -> b -> c -> a");
});

test("long chains do not overflow the call stack", () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => ({ id: `t${i}`, duration: 1, dependsOn: i ? [`t${i - 1}`] : [] }));
  expect(plan({ tasks }).totalDuration).toBe(15000);
  tasks[0].dependsOn = ["t14999"];
  expect(() => plan({ tasks })).toThrow(/Cycle detected: t0 -> t14999/);
});

test("random small DAGs agree with exhaustive chain enumeration", () => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let sample = 0; sample < 300; sample++) {
    const ids = ["g", "a", "f", "b", "e", "c", "d"];
    const tasks: Task[] = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.3) }));
    let bestDuration = -1;
    let bestPath: string[] = [];
    const walk = (task: Task, prefix: string[], duration: number) => {
      const path = [...prefix, task.id];
      duration += task.duration;
      if (duration > bestDuration || (duration === bestDuration && compare(path, bestPath) < 0)) {
        bestDuration = duration;
        bestPath = path;
      }
      for (const child of tasks.filter(child => child.dependsOn.includes(task.id))) walk(child, path, duration);
    };
    for (const task of tasks) walk(task, [], 0);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(bestDuration);
    expect(result.criticalPath).toEqual(bestPath);
    const scheduled = new Set<string>();
    for (const id of result.order) {
      const candidates = tasks.filter(task => !scheduled.has(task.id) && task.dependsOn.every(dependency => scheduled.has(dependency))).map(task => task.id).sort();
      expect(id).toBe(candidates[0]);
      scheduled.add(id);
    }
    expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
  }
});

test("CLI emits a single object or useful stderr with nonzero status", () => {
  // Keep all temporary fixtures inside the project directory.
  const directory = mkdtempSync(join(import.meta.dir, "fixtures-"));
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../src/cli.ts"), ...args]);
  try {
    const valid = join(directory, "input.json");
    const invalid = join(directory, "invalid.json");
    const schema = join(directory, "schema.json");
    const cycle = join(directory, "cycle.json");
    writeFileSync(valid, '{"tasks":[]}');
    writeFileSync(invalid, '{oops');
    writeFileSync(schema, '{"tasks":[{"id":"a","duration":-1}]}');
    writeFileSync(cycle, '{"tasks":[{"id":"a","duration":0,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}');
    const success = invoke("plan", valid);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString()).toBe(JSON.stringify(plan({ tasks: [] })) + "\n");
    const failures: [string[], RegExp][] = [
      [[], /Usage/], [["unknown", valid], /Usage/], [["plan"], /Usage/],
      [["plan", valid, "--extra"], /Usage/], [["plan", "--help"], /Usage/],
      [["plan", invalid], /Invalid JSON/], [["plan", schema], /duration/],
      [["plan", cycle], /a -> b -> a/], [["plan", join(directory, "missing")], /Cannot read/],
    ];
    for (const [args, error] of failures) {
      const result = invoke(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toMatch(error);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
