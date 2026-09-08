import { describe, expect, test } from "bun:test";
import { createPlan, type Task } from "../src/planner";

test("empty plan", () => {
  expect(createPlan({ tasks: [] })).toEqual({
    order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [],
  });
});

test("ready queue order differs from layer order; disconnected scheduling", () => {
  expect(createPlan({ tasks: [
    { id: "z", duration: 2 },
    { id: "b", duration: 3, dependsOn: ["a"] },
    { id: "a", duration: 1 },
    { id: "join", duration: 2, dependsOn: ["z", "b"] },
  ] })).toEqual({
    order: ["a", "b", "z", "join"],
    layers: [["a", "z"], ["b"], ["join"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 },
      z: { start: 0, finish: 2 }, join: { start: 4, finish: 6 } },
    totalDuration: 6, criticalPath: ["a", "b", "join"],
  });
});

test("critical ties compare full sequences, not immediate predecessors", () => {
  const tasks = [
    { id: "a", duration: 1 }, { id: "b", duration: 1 },
    { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "end", duration: 1, dependsOn: ["c", "z"] },
  ];
  expect(createPlan({ tasks }).criticalPath).toEqual(["a", "z", "end"]);
  expect(createPlan({ tasks: tasks.toReversed().map((task) => ({
    ...task, dependsOn: task.dependsOn?.toReversed(),
  })) })).toEqual(createPlan({ tasks }));
});

test("zero durations, prefix ties, and chains starting after zero work", () => {
  expect(createPlan({ tasks: [
    { id: "a", duration: 1 }, { id: "b", duration: 0, dependsOn: ["a"] },
  ] }).criticalPath).toEqual(["a"]);
  expect(createPlan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 2, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
  expect(createPlan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
});

test("fractions and special object keys", () => {
  const result = createPlan({ tasks: [
    { id: "__proto__", duration: 0.5 },
    { id: "constructor", duration: 0.25, dependsOn: ["__proto__"] },
    { id: "toString", duration: 0, dependsOn: ["constructor"] },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

describe("validation", () => {
  for (const input of [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 5, duration: 1 }] },
    ...[undefined, -1, Infinity, NaN, "3", null].map((duration) => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "b", [3], ["b", "b"], ["a"], ["missing"]].map((dependsOn) => ({
      tasks: [{ id: "a", duration: 1, dependsOn }],
    })),
    { tasks: [{ id: "a", duration: 0 }, { id: "a", duration: 1 }] },
  ]) {
    test(`rejects ${JSON.stringify(input)}`, () => expect(() => createPlan(input)).toThrow());
  }
  test("rejects arithmetic overflow", () => {
    expect(() => createPlan({ tasks: [
      { id: "a", duration: Number.MAX_VALUE },
      { id: "b", duration: Number.MAX_VALUE, dependsOn: ["a"] },
    ] })).toThrow("overflows");
  });
});

test("concrete cycle is stable across input permutations", () => {
  const tasks = [
    { id: "free", duration: 1 },
    { id: "c", duration: 1, dependsOn: ["a"] },
    { id: "b", duration: 1, dependsOn: ["c"] },
    { id: "a", duration: 1, dependsOn: ["c", "b"] },
  ];
  for (const ordered of [tasks, tasks.toReversed()]) {
    expect(() => createPlan({ tasks: ordered })).toThrow("Dependency cycle: a -> b -> c -> a");
  }
});

test("deep cycles avoid recursive stack overflow", () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => ({
    id: `n${i}`, duration: 0, dependsOn: [`n${(i + 1) % 15000}`],
  }));
  expect(() => createPlan({ tasks })).toThrow("Dependency cycle: n0 -> n1 -> n2");
});

test("generated DAGs match exhaustive chain and topological-order oracles", () => {
  let seed = 91723;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 100; iteration++) {
    const ids = ["d", "a", "f", "b", "e", "c"];
    const tasks: Task[] = ids.map((id, i) => ({
      id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.35),
    }));
    const chains: { path: string[]; duration: number }[] = [];
    const walk = (path: string[], duration: number) => {
      chains.push({ path, duration });
      for (const task of tasks.filter((task) => task.dependsOn.includes(path.at(-1)!))) {
        walk([...path, task.id], duration + task.duration);
      }
    };
    for (const task of tasks) walk([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || compare(a.path, b.path));
    const orders: string[][] = [];
    const enumerate = (prefix: string[]) => {
      if (prefix.length === tasks.length) orders.push(prefix);
      for (const task of tasks) {
        if (!prefix.includes(task.id) && task.dependsOn.every((id) => prefix.includes(id))) {
          enumerate([...prefix, task.id]);
        }
      }
    };
    enumerate([]);
    orders.sort(compare);
    const result = createPlan({ tasks: tasks.toReversed() });
    expect(result.order).toEqual(orders[0]!);
    expect(result.totalDuration).toBe(chains[0]!.duration);
    expect(result.criticalPath).toEqual(chains[0]!.path);
    for (const task of tasks) {
      const ending = chains.filter((chain) => chain.path.at(-1) === task.id);
      const finish = Math.max(...ending.map((chain) => chain.duration));
      const layer = Math.max(...ending.map((chain) => chain.path.length)) - 1;
      expect(result.earliest[task.id]).toEqual({ start: finish - task.duration, finish });
      expect(result.layers[layer]).toContain(task.id);
    }
  }
});
