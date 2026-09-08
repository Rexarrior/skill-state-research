import { expect, test } from "bun:test";
import { plan, type Task } from "../src/planner";

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready ordering, layers, parallel timing and disconnected components", () => {
  const tasks = [
    { id: "z", duration: 2 },
    { id: "b", duration: 4, dependsOn: ["a"] },
    { id: "c", duration: 2, dependsOn: ["b", "z"] },
    { id: "a", duration: 1 },
  ];
  const result = plan({ tasks });
  expect(result).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 5 }, z: { start: 0, finish: 2 }, c: { start: 5, finish: 7 } },
    totalDuration: 7, criticalPath: ["a", "b", "c"],
  });
  expect(plan({ tasks: tasks.toReversed() })).toEqual(result);
});

test("full sequence tie breaking and zero-duration prefixes/suffixes", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "b", duration: 1 }, { id: "c", duration: 1, dependsOn: ["b"] },
  ] }).criticalPath).toEqual(["a", "z"]);
  expect(plan({ tasks: [
    { id: "a", duration: 0 }, { id: "b", duration: 2, dependsOn: ["a"] },
    { id: "c", duration: 0, dependsOn: ["b"] },
  ] }).criticalPath).toEqual(["a", "b"]);
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] }).criticalPath).toEqual(["a"]);
});

test("special object keys and fractional durations", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 0.5 }, { id: "constructor", duration: 0.25, dependsOn: ["__proto__"] }] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});

const invalid: unknown[] = [null, [], {}, { tasks: {} }, ...[
  [null], [{ id: "", duration: 1 }], [{ id: 1, duration: 1 }], [{ id: "a" }],
  ...[-1, NaN, Infinity, "1", null].map(duration => [{ id: "a", duration }]),
  [{ id: "a", duration: 0 }, { id: "a", duration: 1 }],
  ...[null, "b", [1], ["b", "b"], ["a"], ["missing"]].map(dependsOn => [{ id: "a", duration: 1, dependsOn }]),
].map(tasks => ({ tasks }))];
for (const [index, input] of invalid.entries()) test(`reject invalid schema ${index}`, () => expect(() => plan(input)).toThrow());

test("deterministic concrete cycle", () => {
  const tasks = [{ id: "c", duration: 1, dependsOn: ["b"] }, { id: "a", duration: 1, dependsOn: ["c"] }, { id: "b", duration: 1, dependsOn: ["a"] }];
  expect(() => plan({ tasks })).toThrow("Dependency cycle: a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.toReversed() })).toThrow("Dependency cycle: a -> b -> c -> a");
});

test("long chains avoid recursion limits", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({ id: String(i), duration: 1, dependsOn: i ? [String(i - 1)] : [] }));
  expect(plan({ tasks }).criticalPath.length).toBe(tasks.length);
  tasks[0].dependsOn = [String(tasks.length - 1)];
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("exhaustive small DAGs match independent enumeration of every chain", () => {
  const ids = ["c", "a", "d", "b"];
  const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let mask = 0; mask < 64; mask++) for (let durations = 0; durations < 81; durations++) {
    let code = durations;
    const tasks: Task[] = ids.map(id => { const duration = code % 3; code = Math.floor(code / 3); return { id, duration, dependsOn: [] }; });
    edges.forEach(([from, to], bit) => { if (mask & (1 << bit)) tasks[to].dependsOn.push(ids[from]); });
    let best = -1;
    let chain: string[] = [];
    function visit(index: number, path: string[], sum: number) {
      const next = [...path, ids[index]];
      sum += tasks[index].duration;
      if (sum > best || (sum === best && compare(next, chain) < 0)) { best = sum; chain = next; }
      tasks.forEach((task, child) => { if (task.dependsOn.includes(ids[index])) visit(child, next, sum); });
    }
    tasks.forEach((_, index) => visit(index, [], 0));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(best);
    expect(result.criticalPath).toEqual(chain);
    const remaining = new Set(ids);
    for (const id of result.order) {
      const ready = tasks.filter(t => remaining.has(t.id) && t.dependsOn.every(dep => !remaining.has(dep))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      remaining.delete(id);
    }
  }
});
