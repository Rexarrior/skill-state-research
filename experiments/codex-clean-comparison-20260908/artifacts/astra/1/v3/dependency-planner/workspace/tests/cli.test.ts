import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { plan } from "../src/cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("parallel timing, disconnected components, earliest layers and dynamic ready choices", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3), task("a", 4, ["b"]), task("c", 1, ["z", "a"])] })).toEqual({
    order: ["b", "a", "z", "c"], layers: [["b", "z"], ["a"], ["c"]],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 7 }, z: { start: 0, finish: 2 }, c: { start: 7, finish: 8 } },
    totalDuration: 8, criticalPath: ["b", "a", "c"],
  });
});

test("empty, default dependencies, fractional durations and special object keys", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, task("constructor", 0.25, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});

test("critical path uses full sequence ties and handles zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("a", 1), task("z", 1, ["a"]), task("b", 1), task("c", 1, ["b"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("a", 0), task("b", 2, ["a"]), task("c", 0, ["b"])] }).criticalPath).toEqual(["a", "b"]);
  expect(plan({ tasks: [task("z", 0), task("a", 2, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("b", 0), task("a", 0, ["b"])] }).criticalPath).toEqual(["a"]);
});

describe("validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: null }, { tasks: [null] },
    { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, NaN, Infinity, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "b", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  for (const [i, input] of invalid.entries()) test(`invalid schema ${i}`, () => expect(() => plan(input)).toThrow());
  test("schedule overflow", () => expect(() => plan({ tasks: [task("a", Number.MAX_VALUE), task("b", Number.MAX_VALUE, ["a"])] })).toThrow("overflow"));
});

test("deterministic concrete cycle across reordered input", () => {
  const tasks = [task("c", 1, ["b"]), task("b", 1, ["a"]), task("a", 1, ["c"]), task("d")];
  expect(() => plan({ tasks })).toThrow("a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.toReversed() })).toThrow("a -> b -> c -> a");
});

test("long graphs avoid recursive traversal limits", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(`n${i}`, 1, i ? [`n${i - 1}`] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0]!.dependsOn = ["n11999"];
  expect(() => plan({ tasks })).toThrow("Cycle detected");
});

test("seeded small DAGs match exhaustive chain enumeration", () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const cmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["g", "b", "f", "a", "e", "c", "d"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.35)));
    let max = -1;
    let best: string[] = [];
    const walk = (id: string, path: string[], duration: number) => {
      const t = tasks.find(t => t.id === id)!;
      path = [...path, id];
      duration += t.duration;
      if (duration > max || (duration === max && cmp(path, best) < 0)) { max = duration; best = path; }
      for (const child of tasks.filter(t => t.dependsOn.includes(id))) walk(child.id, path, duration);
    };
    for (const id of ids) walk(id, [], 0);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(max);
    expect(result.criticalPath).toEqual(best);
    expect(plan({ tasks: tasks.toReversed() })).toEqual(result);
  }
});

test("CLI emits one JSON object; errors use stderr and non-zero status", () => {
  const directory = resolve(`tests/.fixtures-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const input = join(directory, "input.json");
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  try {
    writeFileSync(input, JSON.stringify({ tasks: [task("a")] }));
    const ok = cli("plan", input);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toBe("");
    expect(ok.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(ok.stdout.toString()).criticalPath).toEqual(["a"]);
    for (const args of [[], ["other", input], ["plan"], ["plan", input, "--foo"], ["plan", "--foo"], ["plan", join(directory, "missing")]]) {
      const failure = cli(...args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe("");
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ["{bad", '{"tasks":null}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(input, text);
      const failure = cli("plan", input);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe("");
      expect(failure.stderr.toString()).toMatch(/Invalid JSON|tasks|a -> b -> a/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
