import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { plan } from "../src/cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty input", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready queue, depth layers, parallel timing, and disconnected components", () => {
  expect(plan({ tasks: [task("z", 4), task("b", 3), task("a", 2, ["b"]), task("c", 1, ["a", "z"])] })).toEqual({
    order: ["b", "a", "z", "c"], layers: [["b", "z"], ["a"], ["c"]],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 5 }, z: { start: 0, finish: 4 }, c: { start: 5, finish: 6 } },
    totalDuration: 6, criticalPath: ["b", "a", "c"],
  });
});

test("full sequence ties and zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("z", 2, ["a"]), task("b", 2), task("a", 0), task("end", 0, ["z"])] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [task("a", 1), task("b", 0, ["a"]), task("c", 1, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "c"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
});

test("special object keys are safe", () => {
  const result = plan({ tasks: [task("__proto__"), task("constructor", 2, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
  expect(result.totalDuration).toBe(3);
});

describe("validation", () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
    { tasks: [task("a"), task("a")] }, ...[-1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }] }))];
  for (const [index, input] of invalid.entries()) test(`rejects invalid input ${index}`, () => expect(() => plan(input)).toThrow());
  test("defaults dependencies", () => expect(plan({ tasks: [{ id: "a", duration: 0.5 }] }).totalDuration).toBe(0.5));
  test("rejects arithmetic overflow", () => expect(() => plan({ tasks: [task("a", Number.MAX_VALUE), task("b", Number.MAX_VALUE, ["a"])] })).toThrow("finite numeric range"));
});

test("cycles are concrete and deterministic across input permutations", () => {
  const tasks = [task("c", 1, ["b"]), task("a", 1, ["c"]), task("b", 1, ["a"]), task("free")];
  for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow("a -> b -> c -> a");
});

test("small random DAGs agree with exhaustive chain enumeration", () => {
  let seed = 17;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const cmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["d", "a", "f", "c", "b", "e"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.3)));
    const chains: { ids: string[]; duration: number }[] = [];
    const visit = (path: string[], duration: number) => {
      chains.push({ ids: path, duration });
      for (const child of tasks.filter(t => t.dependsOn.includes(path.at(-1)!))) visit([...path, child.id], duration + child.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    chains.sort((a, b) => b.duration - a.duration || cmp(a.ids, b.ids));
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      done.add(id);
    }
    expect(plan({ tasks })).toEqual(result);
  }
});

test("CLI success and failure contracts", () => {
  const dir = mkdtempSync(resolve("tests/.input-"));
  const file = join(dir, "input.json");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args]);
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task("a")] }));
    const good = run(["plan", file]);
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe("");
    expect(good.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(good.stdout.toString()).criticalPath).toEqual(["a"]);
    for (const args of [[], ["other", file], ["plan"], ["plan", file, "--extra"], ["plan", "--help"], ["plan", join(dir, "missing")]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":null}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      writeFileSync(file, text);
      const result = run(["plan", file]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
