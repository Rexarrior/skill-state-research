import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, type Task } from "../src/planner";

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({
    order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
  });
});

test("schedules disconnected tasks and chooses the smallest ready id at every step", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 7 },
    { id: "b", duration: 3 },
    { id: "a", duration: 4, dependsOn: ["b"] },
    { id: "c", duration: 2, dependsOn: ["a", "z"] },
  ] })).toEqual({
    order: ["b", "a", "z", "c"],
    layers: [["b", "z"], ["a"], ["c"]],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 7 },
      z: { start: 0, finish: 7 }, c: { start: 7, finish: 9 } },
    totalDuration: 9, criticalPath: ["b", "a", "c"],
  });
});

test("critical path compares full sequences, not the last predecessor", () => {
  const tasks = [
    { id: "a", duration: 1 }, { id: "b", duration: 1 },
    { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "end", duration: 1, dependsOn: ["c", "z"] },
  ];
  expect(plan({ tasks }).criticalPath).toEqual(["a", "z", "end"]);
});

test("zero durations, prefix ties, and chains starting at non-roots", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 },
    { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 1, dependsOn: ["a", "b"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "b", duration: 0, dependsOn: ["a"] },
  ] }).criticalPath).toEqual(["a"]);
  const result = plan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] },
  ] });
  expect(result.criticalPath).toEqual(["a"]);
  expect(result.layers).toEqual([["z"], ["a"]]);
  expect(result.totalDuration).toBe(0);
});

test("prototype-like ids are ordinary ids and survive JSON serialization", () => {
  const result = JSON.parse(JSON.stringify(plan({ tasks: [
    { id: "__proto__", duration: 0.5 },
    { id: "constructor", duration: 1.25, dependsOn: ["__proto__"] },
    { id: "toString", duration: 0, dependsOn: ["constructor"] },
  ] })));
  expect(Object.keys(result.earliest)).toEqual(["__proto__", "constructor", "toString"]);
  expect(result.earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(1.75);
});

describe("validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    { tasks: [{ id: "a" }] }, { tasks: [{ id: "a", duration: "1" }] },
    ...[-1, Infinity, NaN].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 0 }, { id: "a", duration: 1 }] },
    ...[null, "a", [1], ["b"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
    { tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 1, dependsOn: ["a", "a"] }] },
  ];
  for (const [index, input] of invalid.entries()) {
    test(`rejects invalid schema ${index}`, () => expect(() => plan(input)).toThrow());
  }
  test("rejects overflowing schedule arithmetic", () => {
    expect(() => plan({ tasks: [
      { id: "a", duration: Number.MAX_VALUE },
      { id: "b", duration: Number.MAX_VALUE, dependsOn: ["a"] },
    ] })).toThrow("finite number range");
  });
});

test("cycle is concrete, deterministic, and found in disconnected components", () => {
  const tasks = [
    { id: "outside", duration: 0 },
    { id: "c", duration: 0, dependsOn: ["b"] },
    { id: "b", duration: 0, dependsOn: ["c", "a"] },
    { id: "a", duration: 0, dependsOn: ["b"] },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: [...tasks].reverse().map(t => ({ ...t, dependsOn: t.dependsOn?.toReversed() })) }))
    .toThrow("Cycle detected: a -> b -> a");
});

test("large chains and cycles do not overflow the call stack", () => {
  const tasks: Task[] = Array.from({ length: 15000 }, (_, i) => ({
    id: String(i).padStart(5, "0"), duration: 1,
    dependsOn: i ? [String(i - 1).padStart(5, "0")] : [],
  }));
  expect(plan({ tasks }).criticalPath).toHaveLength(tasks.length);
  tasks[0]!.dependsOn = [tasks.at(-1)!.id];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("seeded DAGs match exhaustive chain enumeration and scheduling invariants", () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 200; iteration++) {
    const ids = ["z", "a", "x", "b", "m", "c", "q"];
    const tasks: Task[] = ids.map((id, i) => ({
      id, duration: Math.floor(random() * 4),
      dependsOn: ids.slice(0, i).filter(() => random() < 0.4),
    }));
    const result = plan({ tasks });
    const chains: { ids: string[]; duration: number }[] = [];
    const visit = (task: Task, path: string[], duration: number) => {
      const next = [...path, task.id];
      const sum = duration + task.duration;
      chains.push({ ids: next, duration: sum });
      for (const child of tasks.filter(t => t.dependsOn.includes(task.id))) visit(child, next, sum);
    };
    for (const task of tasks) visit(task, [], 0);
    chains.sort((a, b) => b.duration - a.duration || compare(a.ids, b.ids));
    expect(result.totalDuration).toBe(chains[0]!.duration);
    expect(result.criticalPath).toEqual(chains[0]!.ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const available = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(available[0]);
      done.add(id);
      const task = tasks.find(t => t.id === id)!;
      expect(result.earliest[id]!.start).toBe(Math.max(0, ...task.dependsOn.map(d => result.earliest[d]!.finish)));
      expect(result.earliest[id]!.finish).toBe(result.earliest[id]!.start + task.duration);
      const layer = result.layers.findIndex(items => items.includes(id));
      expect(layer).toBe(Math.max(-1, ...task.dependsOn.map(d => result.layers.findIndex(items => items.includes(d)))) + 1);
    }
    expect(plan({ tasks: tasks.toReversed().map(t => ({ ...t, dependsOn: t.dependsOn.toReversed() })) })).toEqual(result);
  }
});

test("CLI prints exactly one JSON object and reports failures only on stderr", () => {
  const directory = mkdtempSync(join(process.cwd(), ".planner-test-"));
  const input = join(directory, "input.json");
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };
  const failure = (args: string[], message: string) => {
    const result = run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  };
  try {
    writeFileSync(input, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));
    const result = run("plan", input);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout).totalDuration).toBe(3);
    for (const args of [[], ["plan"], ["other", input], ["plan", input, "--verbose"], ["plan", "--help"]]) {
      failure(args, "Usage:");
    }
    failure(["plan", join(directory, "missing.json")], "Cannot read input file");
    writeFileSync(input, "{");
    failure(["plan", input], "Invalid JSON");
    writeFileSync(input, '{"tasks":[{"id":"a","duration":1e400}]}');
    failure(["plan", input], "finite non-negative");
    writeFileSync(input, '{"tasks":false}');
    failure(["plan", input], '"tasks" array');
    writeFileSync(input, JSON.stringify({ tasks: [
      { id: "b", duration: 1, dependsOn: ["a"] }, { id: "a", duration: 1, dependsOn: ["b"] },
    ] }));
    failure(["plan", input], "a -> b -> a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
