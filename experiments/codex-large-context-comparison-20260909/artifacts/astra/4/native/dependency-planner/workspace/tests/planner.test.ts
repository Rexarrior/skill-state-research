import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan } from "../src/planner";

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready order, depth layers, disconnected tasks and parallel timing", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 8 },
    { id: "b", duration: 2, dependsOn: ["a"] },
    { id: "c", duration: 4, dependsOn: ["a"] },
    { id: "d", duration: 3, dependsOn: ["b", "c"] },
    { id: "a", duration: 1 },
  ] })).toEqual({
    order: ["a", "b", "c", "d", "z"],
    layers: [["a", "z"], ["b", "c"], ["d"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 3 },
      c: { start: 1, finish: 5 }, d: { start: 5, finish: 8 }, z: { start: 0, finish: 8 } },
    totalDuration: 8, criticalPath: ["a", "c", "d"],
  });
});

test("critical ties compare the whole sequence, not the immediate predecessor", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "b", duration: 1 }, { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "end", duration: 1, dependsOn: ["z", "c"] },
  ] }).criticalPath).toEqual(["a", "z", "end"]);
});

test("zero duration prefixes and suffixes", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 2, dependsOn: ["a", "b"] },
    { id: "tail", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
});

test("arbitrary ids are safe object keys", () => {
  const result = plan({ tasks: [
    { id: "__proto__", duration: 1 },
    { id: "constructor", duration: 2, dependsOn: ["__proto__"] },
    { id: "toString", duration: 0 },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

describe("schema validation", () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 4, duration: 1 }] },
    ...[undefined, -1, Infinity, NaN, "2", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["a"], ["missing"], ["b", "b"]].map(dependsOn =>
      ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  for (let i = 0; i < invalid.length; i++) test(`reject invalid schema ${i}`, () => {
    expect(() => plan(invalid[i])).toThrow();
  });
});

test("cycle is concrete and independent of input order", () => {
  const tasks = [
    { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "b", duration: 1, dependsOn: ["a"] },
    { id: "a", duration: 1, dependsOn: ["c"] },
    { id: "free", duration: 1 },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Cycle detected: a -> b -> c -> a");
});

test("long chains avoid recursive stack limits, including cycle detection", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({
    id: `t${i}`, duration: 1, dependsOn: i ? [`t${i - 1}`] : [],
  }));
  const result = plan({ tasks });
  expect(result.totalDuration).toBe(12000);
  expect(result.criticalPath.length).toBe(12000);
  tasks[0].dependsOn = ["t11999"];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("exhaustive path oracle on seeded small DAGs", () => {
  let seed = 123456;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const sequenceCompare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["z", "a", "y", "b", "x", "c"];
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 3),
      dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    let bestDuration = -1;
    let bestPath: string[] = [];
    const visit = (path: string[], duration: number) => {
      if (duration > bestDuration || (duration === bestDuration && sequenceCompare(path, bestPath) < 0)) {
        bestDuration = duration;
        bestPath = path;
      }
      for (const task of tasks) {
        if (task.dependsOn.includes(path[path.length - 1])) visit([...path, task.id], duration + task.duration);
      }
    };
    for (const task of tasks) visit([task.id], task.duration);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(bestDuration);
    expect(result.criticalPath).toEqual(bestPath);
    expect(plan({ tasks: [...tasks].reverse().map(task => ({ ...task, dependsOn: [...task.dependsOn].reverse() })) })).toEqual(result);
  }
});

const temp = mkdtempSync(join(import.meta.dir, ".cli-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
  cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
});

test("CLI emits exactly one JSON object", () => {
  const file = join(temp, "input.json");
  writeFileSync(file, JSON.stringify({ tasks: [{ id: "build", duration: 0.5 }] }));
  const result = run("plan", file);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString().trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout.toString()).totalDuration).toBe(0.5);
});

test("CLI failures have nonzero status, useful stderr and empty stdout", () => {
  const badJson = join(temp, "bad.json");
  const badSchema = join(temp, "schema.json");
  const cycle = join(temp, "cycle.json");
  writeFileSync(badJson, "{");
  writeFileSync(badSchema, '{"tasks":[{"id":"a","duration":1e999}]}');
  writeFileSync(cycle, JSON.stringify({ tasks: [
    { id: "b", duration: 1, dependsOn: ["a"] }, { id: "a", duration: 1, dependsOn: ["b"] },
  ] }));
  for (const [args, message] of [
    [[], "command"], [["unknown"], "command"], [["plan"], "input file"],
    [["plan", "--foo"], "flag"], [["plan", badJson, "extra"], "input file"],
    [["plan", join(temp, "missing.json")], "Cannot read"], [["plan", badJson], "Invalid JSON"],
    [["plan", badSchema], "finite non-negative"], [["plan", cycle], "a -> b -> a"],
  ] as [string[], string][]) {
    const result = run(...args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(message);
  }
});
