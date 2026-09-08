import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plan } from "../src/cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("parallel scheduling, earliest layers, and lexicographic ready queue", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3), task("a", 4, ["b"]), task("end", 1, ["a", "z"])] })).toEqual({
    order: ["b", "a", "z", "end"], layers: [["b", "z"], ["a"], ["end"]],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 7 }, z: { start: 0, finish: 2 }, end: { start: 7, finish: 8 } },
    totalDuration: 8, criticalPath: ["b", "a", "end"],
  });
});

test("empty input and omitted dependencies", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(plan({ tasks: [{ id: "x", duration: 0 }] }).criticalPath).toEqual(["x"]);
});

test("critical ties compare complete sequences and shorter prefixes", () => {
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("z", 2, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("a", 2), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("z", 0), task("a", 2, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("special object keys are safe", () => {
  const result = plan({ tasks: [task("__proto__", 2), task("constructor", 1, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});

describe("validation", () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
    { tasks: [task("a"), task("a")] }, { tasks: [task("a", -1)] }, { tasks: [task("a", Infinity)] },
    { tasks: [task("a", NaN)] }, { tasks: [{ id: "a", duration: "1" }] },
    { tasks: [{ id: "a", duration: 1, dependsOn: null }] },
    { tasks: [{ id: "a", duration: 1, dependsOn: [1] }] },
    { tasks: [task("a", 1, ["b"])] }, { tasks: [task("a", 1, ["a"])] },
    { tasks: [task("a"), task("b", 1, ["a", "a"])] }];
  for (const [i, input] of invalid.entries()) test(`invalid schema ${i}`, () => expect(() => plan(input)).toThrow());
});

test("cycle is concrete and independent of input ordering", () => {
  const tasks = [task("c", 1, ["b"]), task("a", 1, ["c"]), task("b", 1, ["a"]), task("free")];
  expect(() => plan({ tasks })).toThrow("a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("a -> b -> c -> a");
});

test("random small DAGs agree with exhaustive chain enumeration", () => {
  let seed = 17;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length - b.length;
  };
  for (let round = 0; round < 200; round++) {
    const ids = ["f", "a", "e", "b", "d", "c"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < .35)));
    const chains: { path: string[]; duration: number }[] = [];
    function walk(path: string[], duration: number) {
      chains.push({ path, duration });
      for (const t of tasks) if (t.dependsOn.includes(path.at(-1)!)) walk([...path, t.id], duration + t.duration);
    }
    for (const t of tasks) walk([t.id], t.duration);
    chains.sort((a, b) => b.duration - a.duration || compare(a.path, b.path));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0]!.duration);
    expect(result.criticalPath).toEqual(chains[0]!.path);
    const pending = new Set(ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => pending.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      pending.delete(id); done.add(id);
    }
    expect(plan({ tasks: [...tasks].reverse().map(t => ({ ...t, dependsOn: [...t.dependsOn].reverse() })) })).toEqual(result);
  }
});

test("CLI emits one JSON object and useful failures", () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-input-"));
  const file = join(dir, "input.json");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a", 2)] }));
    const valid = run("plan", file);
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr.toString()).toBe("");
    expect(valid.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(valid.stdout.toString()).totalDuration).toBe(2);
    for (const args of [[], ["unknown", file], ["plan", "--help"], ["plan", file, "--extra"], ["plan", join(dir, "missing")]]) {
      const result = run(...args);
      expect(result.exitCode).not.toBe(0); expect(result.stderr.length).toBeGreaterThan(0); expect(result.stdout.length).toBe(0);
    }
    for (const text of ["{", '{"tasks":false}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, text);
      const result = run("plan", file);
      expect(result.exitCode).not.toBe(0); expect(result.stderr.length).toBeGreaterThan(0); expect(result.stdout.length).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
