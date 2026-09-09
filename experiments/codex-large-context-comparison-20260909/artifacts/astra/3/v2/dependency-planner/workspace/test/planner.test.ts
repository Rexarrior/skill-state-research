import { describe, expect, test } from "bun:test";
import { plan } from "../src/planner";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("newly ready tasks compete lexicographically; depth and timing differ", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 5), task("c", 1, ["b", "z"])] })).toEqual({
    order: ["a", "b", "z", "c"],
    layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 5 }, b: { start: 5, finish: 8 }, z: { start: 0, finish: 2 }, c: { start: 8, finish: 9 } },
    totalDuration: 9, criticalPath: ["a", "b", "c"],
  });
});

test("ties compare whole paths, including zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"]), task("z", 3, ["a", "b"]), task("zz", 0, ["z"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 1), task("z", 2, ["a"]), task("b", 1), task("c", 2, ["b"])] }).criticalPath).toEqual(["a", "z"]);
});

test("arbitrary object-property ids and omitted dependencies", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0 }, task("constructor", 2, ["__proto__"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

for (const input of [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task("")] },
  { tasks: [task("a"), task("a")] }, ...[-1, Infinity, NaN, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
  ...[null, "a", [1], ["x"], ["a"], ["b", "b"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }, task("b")] }))]) {
  test(`reject invalid schema ${JSON.stringify(input)}`, () => expect(() => plan(input)).toThrow());
}

test("cycles are concrete and independent of input order", () => {
  const tasks = [task("c", 1, ["b"]), task("b", 1, ["a", "c"]), task("a"), task("z")];
  expect(() => plan({ tasks })).toThrow("Cycle detected: b -> c -> b");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Cycle detected: b -> c -> b");
});

test("iterative algorithms handle deep graphs", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i).padStart(5, "0"), 1, i ? [String(i - 1).padStart(5, "0")] : []));
  expect(plan({ tasks }).criticalPath.length).toBe(tasks.length);
  tasks[0].dependsOn = [tasks[tasks.length - 1].id];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("random DAGs match exhaustive chain and scheduling oracles", () => {
  let seed = 918;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const comparePaths = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let trial = 0; trial < 250; trial++) {
    const ids = ["f", "a", "d", "b", "e", "c"];
    const tasks = ids.map((id, i) => task(id, random(4), ids.slice(0, i).filter(() => random(3) === 0)));
    const chains: { path: string[]; duration: number }[] = [];
    const walk = (path: string[], duration: number) => {
      chains.push({ path, duration });
      for (const next of tasks.filter(t => t.dependsOn.includes(path[path.length - 1]))) walk([...path, next.id], duration + next.duration);
    };
    for (const t of tasks) walk([t.id], t.duration);
    chains.sort((a, b) => b.duration - a.duration || comparePaths(a.path, b.path));
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].path);
    const done = new Set<string>();
    for (const id of result.order) {
      expect(id).toBe(tasks.filter(t => !done.has(t.id) && t.dependsOn.every(d => done.has(d))).map(t => t.id).sort()[0]);
      done.add(id);
      expect(result.earliest[id].finish).toBe(Math.max(...chains.filter(c => c.path.at(-1) === id).map(c => c.duration)));
      expect(result.layers.findIndex(layer => layer.includes(id))).toBe(Math.max(...chains.filter(c => c.path.at(-1) === id).map(c => c.path.length - 1)));
    }
    expect(plan({ tasks })).toEqual(result);
  }
});
