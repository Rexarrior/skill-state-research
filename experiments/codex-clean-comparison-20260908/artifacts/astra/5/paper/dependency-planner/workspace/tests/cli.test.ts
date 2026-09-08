import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
function run(value: unknown, args?: string[]) {
  const dir = mkdtempSync(join(import.meta.dir, ".input-"));
  const file = join(dir, "input.json");
  try {
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    const result = Bun.spawnSync([process.execPath, cli, ...(args ?? ["plan", file])]);
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty and parallel scheduling with global ready ordering", () => {
  expect(JSON.parse(run({ tasks: [] }).out)).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const r = run({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 2, ["b", "z"])] });
  expect(r.code).toBe(0); expect(r.err).toBe("");
  expect(r.out.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(r.out)).toEqual({ order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]], earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 6 } }, totalDuration: 6, criticalPath: ["a", "b", "c"] });
});

test("critical path full-sequence ties, zero durations, and special object keys", () => {
  expect(JSON.parse(run({ tasks: [task("a", 1), task("b", 0, ["a"]), task("z", 1, ["a", "b"])] }).out).criticalPath).toEqual(["a", "b", "z"]);
  expect(JSON.parse(run({ tasks: [task("z", 0), task("a", 0, ["z"])] }).out).criticalPath).toEqual(["a"]);
  const r = JSON.parse(run({ tasks: [task("__proto__", 2), task("constructor", 1, ["__proto__"])] }).out);
  expect(r.earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(r.criticalPath).toEqual(["__proto__", "constructor"]);
});

test("rejects malformed schema, JSON, CLI, and missing files", () => {
  const invalid = ["{", {}, { tasks: null }, { tasks: [null] }, { tasks: [task("")] }, { tasks: [task("a"), task("a")] }, { tasks: [task("a", -1)] }, '{"tasks":[{"id":"a","duration":1e999}]}', { tasks: [{ id: "a", duration: "1" }] }, { tasks: [task("a", 1, ["x"])] }, { tasks: [task("a", 1, ["a"])] }, { tasks: [task("a"), task("b", 1, ["a", "a"])] }, { tasks: [{ ...task("a"), dependsOn: null }] }, { tasks: [{ ...task("a"), dependsOn: [3] }] }];
  for (const input of invalid) { const r = run(input); expect(r.code).not.toBe(0); expect(r.out).toBe(""); expect(r.err.length).toBeGreaterThan(0); }
  for (const args of [[], ["wat"], ["plan", "--help"], ["plan", "missing.json"], ["plan", "x", "--x"]]) expect(run({}, args).code).not.toBe(0);
  expect(run({ tasks: [{ id: "a", duration: 0 }] }).code).toBe(0);
});

test("cycles are concrete and independent of input ordering", () => {
  const tasks = [task("c", 1, ["b"]), task("a", 1, ["c"]), task("b", 1, ["a"]), task("x")];
  const a = run({ tasks }), b = run({ tasks: tasks.toReversed() });
  expect(a.code).not.toBe(0); expect(a.out).toBe(""); expect(a.err).toBe(b.err); expect(a.err).toContain("a -> b -> c -> a");
});

test("exhaustive chain oracle for randomized DAGs", () => {
  let seed = 42;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const cmp = (a: string[], b: string[]) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return a.length - b.length; };
  for (let trial = 0; trial < 35; trial++) {
    const ids = ["d", "a", "f", "b", "e", "c"];
    const tasks = ids.map((id, i) => task(id, Math.floor(rand() * 4), ids.slice(0, i).filter(() => rand() < 0.35)));
    let max = -1, best: string[] = [];
    function visit(path: string[], sum: number) {
      if (sum > max || sum === max && cmp(path, best) < 0) { max = sum; best = path; }
      for (const t of tasks) if (t.dependsOn.includes(path.at(-1)!)) visit([...path, t.id], sum + t.duration);
    }
    for (const t of tasks) visit([t.id], t.duration);
    const r = run({ tasks: tasks.toReversed() }); expect(r.code).toBe(0);
    const result = JSON.parse(r.out); expect(result.totalDuration).toBe(max); expect(result.criticalPath).toEqual(best);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]); done.add(id);
    }
  }
});
