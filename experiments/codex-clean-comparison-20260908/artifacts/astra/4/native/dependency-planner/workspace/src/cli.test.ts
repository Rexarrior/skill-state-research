import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plan } from "./cli";

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready order, layers, timings, disconnected components and full-path ties", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 3 },
    { id: "b", duration: 2, dependsOn: ["a"] },
    { id: "a", duration: 1 },
    { id: "end", duration: 4, dependsOn: ["z", "b"] },
    { id: "isolated", duration: 0 },
  ] })).toEqual({
    order: ["a", "b", "isolated", "z", "end"],
    layers: [["a", "isolated", "z"], ["b"], ["end"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 3 },
      end: { start: 3, finish: 7 }, isolated: { start: 0, finish: 0 }, z: { start: 0, finish: 3 } },
    totalDuration: 7,
    criticalPath: ["a", "b", "end"],
  });
});

test("zero durations allow shorter prefixes and later chain starts", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 0 },
    { id: "a", duration: 2, dependsOn: ["z"] },
    { id: "b", duration: 0, dependsOn: ["a"] },
  ] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0 }] }).criticalPath).toEqual(["a"]);
});

test("ids that are object prototype properties are preserved", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 1 },
    { id: "constructor", duration: 2, dependsOn: ["__proto__"] }] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

test("schema validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 2, duration: 1 }] },
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["missing"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 0, dependsOn }] })),
    { tasks: [{ id: "a", duration: 0 }, { id: "a", duration: 1 }] },
    { tasks: [{ id: "a", duration: 0 }, { id: "b", duration: 1, dependsOn: ["a", "a"] }] },
  ];
  for (const input of invalid) expect(() => plan(input)).toThrow();
});

test("cycle reports are concrete and invariant under input permutation", () => {
  const tasks = [
    { id: "c", duration: 1, dependsOn: ["b", "a"] },
    { id: "b", duration: 1, dependsOn: ["c"] },
    { id: "a", duration: 1, dependsOn: ["c"] },
    { id: "independent", duration: 1 },
  ];
  for (const input of [tasks, [...tasks].reverse()]) {
    expect(() => plan({ tasks: input })).toThrow("Dependency cycle: a -> c -> a");
  }
});

test("long cycles do not overflow the call stack", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({
    id: `n${i}`, duration: 0, dependsOn: [`n${(i + 1) % 12000}`],
  }));
  expect(() => plan({ tasks })).toThrow("Dependency cycle: n0 -> n1 -> n2");
});

test("schedule overflow is reported", () => {
  expect(() => plan({ tasks: [{ id: "a", duration: Number.MAX_VALUE },
    { id: "b", duration: Number.MAX_VALUE, dependsOn: ["a"] }] })).toThrow("overflows");
});

test("seeded DAGs agree with exhaustive chain enumeration", () => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["z", "a", "y", "b", "x", "c", "w"];
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4),
      dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    const chains: { path: string[]; duration: number }[] = [];
    const visit = (path: string[], duration: number) => {
      chains.push({ path, duration });
      for (const task of tasks) if (task.dependsOn.includes(path[path.length - 1]!)) {
        visit([...path, task.id], duration + task.duration);
      }
    };
    for (const task of tasks) visit([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || comparePaths(a.path, b.path));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0]!.duration);
    expect(result.criticalPath).toEqual(chains[0]!.path);
    expect(plan({ tasks: [...tasks].reverse().map(task => ({ ...task, dependsOn: [...task.dependsOn].reverse() })) })).toEqual(result);
    const completed = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(task => !completed.has(task.id) && task.dependsOn.every(dep => completed.has(dep))).map(task => task.id).sort();
      expect(id).toBe(ready[0]);
      completed.add(id);
      const task = tasks.find(task => task.id === id)!;
      expect(result.earliest[id]!.start).toBe(Math.max(0, ...task.dependsOn.map(dep => result.earliest[dep]!.finish)));
      const expectedLayer = Math.max(-1, ...task.dependsOn.map(dep => result.layers.findIndex(layer => layer.includes(dep)))) + 1;
      expect(result.layers[expectedLayer]).toContain(id);
    }
  }
});

const fixtureDir = join(import.meta.dir, `.test-fixtures-${process.pid}`);
beforeAll(async () => {
  await mkdir(fixtureDir);
  await writeFile(join(fixtureDir, "valid.json"), '{"tasks":[{"id":"a","duration":1.5}]}');
  await writeFile(join(fixtureDir, "invalid.json"), '{broken');
  await writeFile(join(fixtureDir, "schema.json"), '{"tasks":null}');
  await writeFile(join(fixtureDir, "cycle.json"), JSON.stringify({ tasks: [
    { id: "a", duration: 1, dependsOn: ["b"] }, { id: "b", duration: 1, dependsOn: ["a"] },
  ] }));
});
afterAll(() => rm(fixtureDir, { recursive: true, force: true }));

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "cli.ts"), ...args]);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("CLI emits exactly one JSON object", () => {
  const result = run(["plan", join(fixtureDir, "valid.json")]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.out).totalDuration).toBe(1.5);
});

test("CLI failures use stderr and nonzero exit status", () => {
  for (const [args, message] of [
    [[], "Usage"], [["unknown"], "Usage"], [["plan"], "Usage"],
    [["plan", "--help"], "Usage"], [["plan", "x", "--verbose"], "Usage"],
    [["plan", join(fixtureDir, "missing.json")], "ENOENT"],
    [["plan", join(fixtureDir, "invalid.json")], "Invalid JSON"],
    [["plan", join(fixtureDir, "schema.json")], "tasks array"],
    [["plan", join(fixtureDir, "cycle.json")], "a -> b -> a"],
  ] as [string[], string][]) {
    const result = run(args);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toContain(message);
  }
});
