import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plan } from "./cli";

test("empty plan", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready tasks compete globally; layers and parallel timing are independent", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 2 },
    { id: "b", duration: 3, dependsOn: ["a"] },
    { id: "a", duration: 1 },
    { id: "join", duration: 4, dependsOn: ["z", "b"] },
  ] })).toEqual({
    order: ["a", "b", "z", "join"], layers: [["a", "z"], ["b"], ["join"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, join: { start: 4, finish: 8 } },
    totalDuration: 8, criticalPath: ["a", "b", "join"],
  });
});

test("zero-duration prefix and suffix ties compare full sequences", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 0 }, { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 3, dependsOn: ["a", "b"] },
    { id: "tail", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] }).criticalPath).toEqual(["a"]);
});

test("special object property names are safe ids", () => {
  const result = plan({ tasks: [ { id: "__proto__", duration: 2 }, { id: "constructor", duration: 1, dependsOn: ["__proto__"] } ] });
  expect(Object.hasOwn(result.earliest, "__proto__")).toBe(true);
  expect(result.earliest["__proto__"]).toEqual({ start: 0, finish: 2 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

describe("schema validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 0 }] }, { tasks: [{ id: 1, duration: 0 }] },
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["missing"], ["a"], ["b", "b"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 0, dependsOn }, { id: "b", duration: 0 }] })),
  ];
  for (const [index, input] of invalid.entries()) test(`rejects invalid input ${index}`, () => expect(() => plan(input)).toThrow());
});

test("cycles are concrete and invariant to task/dependency input order", () => {
  const tasks = [ { id: "c", duration: 0, dependsOn: ["b", "a"] }, { id: "b", duration: 0, dependsOn: ["c"] }, { id: "a", duration: 0, dependsOn: ["b"] } ];
  expect(() => plan({ tasks })).toThrow("Dependency cycle: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.reverse().map(t => ({ ...t, dependsOn: t.dependsOn.reverse() })) })).toThrow("Dependency cycle: a -> b -> c -> a");
});

test("seeded DAGs agree with exhaustive dependency-chain enumeration", () => {
  let seed = 8192;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const cmp = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 250; trial++) {
    const ids = ["z", "a", "d", "b", "y", "c"].sort(() => random() - 0.5);
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    const chains: { path: string[]; duration: number }[] = [];
    function walk(path: string[], duration: number) {
      chains.push({ path, duration });
      for (const task of tasks) if (task.dependsOn.includes(path.at(-1)!)) walk([...path, task.id], duration + task.duration);
    }
    for (const task of tasks) walk([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || cmp(a.path, b.path));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0]!.duration);
    expect(result.criticalPath).toEqual(chains[0]!.path);
    expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
    const remaining = new Set(ids);
    for (const id of result.order) {
      expect(id).toBe(tasks.filter(t => remaining.has(t.id) && t.dependsOn.every(d => !remaining.has(d))).map(t => t.id).sort()[0]);
      remaining.delete(id);
    }
    for (const task of tasks) {
      const layer = result.layers.findIndex(l => l.includes(task.id));
      expect(layer).toBe(Math.max(-1, ...task.dependsOn.map(d => result.layers.findIndex(l => l.includes(d)))) + 1);
      expect(result.earliest[task.id]!.start).toBe(Math.max(0, ...task.dependsOn.map(d => result.earliest[d]!.finish)));
    }
  }
});

test("long chains avoid recursive stack limits", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({ id: `t${i}`, duration: 1, dependsOn: i ? [`t${i - 1}`] : [] }));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0]!.dependsOn.push("t11999");
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("CLI emits one JSON object and useful errors without stdout", () => {
  const dir = mkdtempSync(join(process.cwd(), ".planner-test-"));
  const input = join(dir, "input.json");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  try {
    writeFileSync(input, JSON.stringify({ tasks: [{ id: "a", duration: 1.5 }] }));
    const success = run("plan", input);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).totalDuration).toBe(1.5);
    for (const args of [[], ["unknown", input], ["plan"], ["plan", input, "--x"], ["plan", "--help"], ["plan", join(dir, "missing.json")]]) {
      const result = run(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const [text, message] of [["{", "Invalid JSON"], ['{"tasks":{}}', "tasks array"], ['{"tasks":[{"id":"a","duration":0,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}', "a -> b -> a"]]) {
      writeFileSync(input, text!);
      const result = run("plan", input);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(message!);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
