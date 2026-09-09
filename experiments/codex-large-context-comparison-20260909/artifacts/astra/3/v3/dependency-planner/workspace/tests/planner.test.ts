import { describe, expect, test } from "bun:test";
import { plan } from "../src/cli";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

test("schedule, layers, disconnected components and dynamic ready ordering", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 1 },
    { id: "b", duration: 3, dependsOn: ["a"] },
    { id: "a", duration: 2 },
    { id: "c", duration: 4, dependsOn: ["z", "b"] },
  ] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 2 }, b: { start: 2, finish: 5 }, z: { start: 0, finish: 1 }, c: { start: 5, finish: 9 } },
    totalDuration: 9, criticalPath: ["a", "b", "c"],
  });
});

test("empty input and special object keys", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [ { id: "__proto__", duration: 0.5 }, { id: "constructor", duration: 1.25, dependsOn: ["__proto__"] } ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(1.75);
});

describe("schema validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    ...[-1, Infinity, NaN, "1", null, undefined].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["x"], ["a"], ["b", "b"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }, { id: "b", duration: 1 }] })),
  ];
  for (const [index, input] of invalid.entries()) test(`rejects invalid input ${index}`, () => expect(() => plan(input)).toThrow());
});

test("deterministic concrete cycle under input permutations", () => {
  const tasks = [{ id: "c", duration: 0, dependsOn: ["a"] }, { id: "a", duration: 0, dependsOn: ["b"] }, { id: "b", duration: 0, dependsOn: ["c"] }, { id: "free", duration: 1 }];
  expect(() => plan({ tasks })).toThrow("a -> b -> c -> a");
  expect(() => plan({ tasks: tasks.toReversed() })).toThrow("a -> b -> c -> a");
});

test("exhaustive four-node DAGs and binary durations match all-chain oracle", () => {
  const ids = ["d", "a", "c", "b"];
  const edges: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) edges.push([i, j]);
  function compare(a: string[], b: string[]) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  }
  for (let mask = 0; mask < 64; mask++) for (let durations = 0; durations < 16; durations++) {
    const tasks = ids.map((id, i) => ({ id, duration: (durations >> i) & 1, dependsOn: edges.filter(([from, to], bit) => to === i && (mask & (1 << bit))).map(([from]) => ids[from]) }));
    const chains: { path: string[]; duration: number }[] = [];
    function visit(path: string[], duration: number) {
      chains.push({ path, duration });
      for (const task of tasks) if (task.dependsOn.includes(path[path.length - 1])) visit([...path, task.id], duration + task.duration);
    }
    for (const task of tasks) visit([task.id], task.duration);
    chains.sort((a, b) => b.duration - a.duration || compare(a.path, b.path));
    const actual = plan({ tasks });
    expect(actual.totalDuration).toBe(chains[0].duration);
    expect(actual.criticalPath).toEqual(chains[0].path);
    expect(plan({ tasks: tasks.toReversed().map(task => ({ ...task, dependsOn: task.dependsOn.toReversed() })) })).toEqual(actual);
  }
});

test("long chains and cycles avoid recursion limits", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({ id: `t${i}`, duration: 1, dependsOn: i ? [`t${i - 1}`] : [] }));
  expect(plan({ tasks }).criticalPath.length).toBe(tasks.length);
  tasks[0].dependsOn.push(tasks[tasks.length - 1].id);
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("CLI emits exactly one JSON object, and failures use only stderr", () => {
  const directory = mkdtempSync(join(process.cwd(), ".planner-test-"));
  const file = join(directory, "input.json");
  const cli = resolve("src/cli.ts");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: process.cwd() });
  try {
    writeFileSync(file, '{"tasks":[{"id":"a","duration":2}]}');
    const success = run(["plan", file]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).criticalPath).toEqual(["a"]);
    for (const args of [[], ["unknown", file], ["plan", file, "--bad"], ["plan", "--bad"], ["plan", join(directory, "missing.json")]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const [input, message] of [["{", "Invalid JSON"], ['{"tasks":false}', "tasks"], ['{"tasks":[{"id":"a","duration":0,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}', "a -> b -> a"], ['{"tasks":[{"id":"a","duration":1e400}]}', "finite"]]) {
      writeFileSync(file, input);
      const result = run(["plan", file]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(message);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
