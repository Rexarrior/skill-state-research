import { describe, expect, test } from "bun:test";
import { plan, validate } from "../src/cli";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty input", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready queue reconsiders newly ready tasks; layers and parallel timings", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 2, ["b", "z"])] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 6 } },
    totalDuration: 6, criticalPath: ["a", "b", "c"],
  });
});

test("full path tie breaks and zero-duration prefixes", () => {
  expect(plan({ tasks: [task("a", 0), task("b", 1, ["a"]), task("c", 1), task("end", 2, ["b", "c"])] }).criticalPath).toEqual(["a", "b", "end"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 2), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("c", 2, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "c"]);
});

test("special object keys and default dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, task("constructor", 1, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});

describe("validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [task("")] }, { tasks: [task("a"), task("a")] },
    ...[-1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  invalid.forEach((input, i) => test(`rejects invalid schema ${i}`, () => expect(() => validate(input)).toThrow()));
});

test("cycle is concrete and deterministic under input permutations", () => {
  const tasks = [task("c", 1, ["a"]), task("a", 1, ["b"]), task("b", 1, ["c"]), task("free")];
  expect(() => plan({ tasks })).toThrow("Dependency cycle: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.toReversed() })).toThrow("Dependency cycle: a -> b -> c -> a");
});

test("deep graphs do not require recursive traversal", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i).padStart(5, "0"), 1, i ? [String(i - 1).padStart(5, "0")] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0]!.dependsOn = [tasks.at(-1)!.id];
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("seeded DAGs match exhaustive dependency-chain enumeration", () => {
  let seed = 731;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["g", "a", "f", "b", "e", "c", "d"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.35)));
    let max = -1;
    let best: string[] = [];
    const walk = (path: string[], sum: number) => {
      if (sum > max || sum === max && comparePaths(path, best) < 0) { max = sum; best = path; }
      for (const next of tasks.filter(t => t.dependsOn.includes(path.at(-1)!))) walk([...path, next.id], sum + next.duration);
    };
    for (const t of tasks) walk([t.id], t.duration);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(max);
    expect(result.criticalPath).toEqual(best);
    expect(plan({ tasks: tasks.toReversed().map(t => ({ ...t, dependsOn: t.dependsOn.toReversed() })) })).toEqual(result);
  }
});

test("CLI emits a single JSON object and failures use stderr", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".test-input-"));
  const cli = join(import.meta.dir, "../src/cli.ts");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", cli, ...args]);
  try {
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify({ tasks: [task("a", 2)] }));
    const good = run(["plan", file]);
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe("");
    expect(good.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(good.stdout.toString()).totalDuration).toBe(2);
    for (const args of [[], ["unknown", file], ["plan"], ["plan", file, "--x"], ["plan", "--help"], ["plan", join(dir, "absent.json")]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const [text, message] of [["{bad", "Invalid JSON"], ["{}", "tasks"], [JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] }), "a -> b -> a"]]) {
      await writeFile(file, text!);
      const result = run(["plan", file]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(message!);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
