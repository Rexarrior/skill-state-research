import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { plan } from "../src/cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("parallel scheduling, lexical ready queue, layers and disconnected tasks", () => {
  expect(plan({ tasks: [task("z", 2), task("c", 4, ["a", "b"]), task("b", 3), task("a", 1)] })).toEqual({
    order: ["a", "b", "c", "z"], layers: [["a", "b", "z"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 0, finish: 3 }, c: { start: 3, finish: 7 }, z: { start: 0, finish: 2 } },
    totalDuration: 7, criticalPath: ["b", "c"],
  });
  expect(plan({ tasks: [task("b"), task("a", 1, ["b"]), task("z")] }).order).toEqual(["b", "a", "z"]);
});

test("empty tasks, defaults, decimal durations and special object keys", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, task("constructor", 0.25, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});

test("critical paths compare full sequences, including zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("a"), task("z", 1, ["a"]), task("b"), task("c", 1, ["b"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 2, ["z"]), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 0), task("z", 2, ["a"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("invalid schemas are rejected", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [[]] },
    { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, NaN, Infinity, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["missing"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  for (const input of invalid) expect(() => plan(input)).toThrow();
});

test("cycles are concrete and deterministic under input permutations", () => {
  const tasks = [task("c", 1, ["b"]), task("a", 1, ["c"]), task("b", 1, ["a"]), task("d")];
  for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow("Cycle detected: a -> b -> c -> a");
});

test("random DAGs match exhaustive chain enumeration and scheduling invariants", () => {
  let seed = 19;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 200; iteration++) {
    const ids = ["d", "b", "g", "a", "f", "c", "e"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.35)));
    const result = plan({ tasks: [...tasks].reverse() });
    let bestDuration = -1;
    let best: string[] = [];
    const visit = (path: string[], duration: number) => {
      if (duration > bestDuration || (duration === bestDuration && comparePaths(path, best) < 0)) {
        bestDuration = duration; best = path;
      }
      for (const child of tasks.filter(t => t.dependsOn.includes(path[path.length - 1]))) visit([...path, child.id], duration + child.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    expect(result.totalDuration).toBe(bestDuration);
    expect(result.criticalPath).toEqual(best);
    const done = new Set<string>();
    for (const id of result.order) {
      expect(id).toBe(tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort()[0]);
      done.add(id);
    }
    for (const t of tasks) {
      const level = result.layers.findIndex(layer => layer.includes(t.id));
      expect(level).toBe(Math.max(-1, ...t.dependsOn.map(d => result.layers.findIndex(layer => layer.includes(d)))) + 1);
      expect(result.earliest[t.id].start).toBe(Math.max(0, ...t.dependsOn.map(d => result.earliest[d].finish)));
    }
  }
});

test("CLI emits one JSON object and failures use stderr with nonzero status", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".fixtures-"));
  const cli = resolve(import.meta.dir, "../src/cli.ts");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", cli, ...args]);
  try {
    const input = join(dir, "input.json");
    writeFileSync(input, JSON.stringify({ tasks: [task("a")] }));
    const success = run(["plan", input]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString())).toEqual(plan({ tasks: [task("a")] }));
    const failures = [[], ["unknown", input], ["plan"], ["plan", "--help"], ["plan", input, "--extra"], ["plan", join(dir, "missing")]];
    for (const args of failures) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":[{"id":"a","duration":1e999}]}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(input, text);
      const result = run(["plan", input]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
