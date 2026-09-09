import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { plan } from "../src/cli";

const fixtureDir = fileURLToPath(new URL(`.fixtures-${process.pid}/`, import.meta.url));
mkdirSync(fixtureDir, { recursive: true });
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
let fixtureNumber = 0;
function cli(args: string[]) {
  return Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe", stderr: "pipe",
  });
}
function fixture(contents: string) {
  const path = `${fixtureDir}/${fixtureNumber++}.json`;
  writeFileSync(path, contents);
  return path;
}

test("plans disconnected branches with distinct order and layers", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 2 },
    { id: "b", duration: 3, dependsOn: ["a"] },
    { id: "a", duration: 1 },
    { id: "join", duration: 4, dependsOn: ["z", "b"] },
  ] })).toEqual({
    order: ["a", "b", "z", "join"],
    layers: [["a", "z"], ["b"], ["join"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 },
      z: { start: 0, finish: 2 }, join: { start: 4, finish: 8 } },
    totalDuration: 8,
    criticalPath: ["a", "b", "join"],
  });
});

test("empty input and special object keys", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [
    { id: "__proto__", duration: 0.5 },
    { id: "constructor", duration: 0.25, dependsOn: ["__proto__"] },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});

test("full sequence ties, including zero-duration prefixes and endpoints", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 },
    { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 2, dependsOn: ["a", "b"] },
    { id: "zz", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [
    { id: "b", duration: 1 }, { id: "a", duration: 1 },
    { id: "c", duration: 2, dependsOn: ["b"] },
    { id: "z", duration: 2, dependsOn: ["a"] },
  ] }).criticalPath).toEqual(["a", "z"]);
});

test("rejects invalid schemas and dependency references", () => {
  const bad = [null, [], {}, { tasks: null }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    ...[undefined, -1, Infinity, NaN, "1", null].map((duration) => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["b", "b"], ["missing"], ["a"]].map((dependsOn) => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
  ];
  for (const input of bad) expect(() => plan(input)).toThrow();
});

test("reports deterministic concrete cycle in disconnected graphs", () => {
  const tasks = [
    { id: "d", duration: 1, dependsOn: ["b"] },
    { id: "b", duration: 1, dependsOn: ["c"] },
    { id: "c", duration: 1, dependsOn: ["d"] },
    { id: "a", duration: 0 },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: b -> d -> c -> b");
  expect(() => plan({ tasks: tasks.reverse() })).toThrow("Cycle detected: b -> d -> c -> b");
});

test("CLI emits exactly one JSON line and useful failures on stderr", () => {
  const success = cli(["plan", fixture('{"tasks":[]}')]);
  expect(success.exitCode).toBe(0);
  expect(success.stderr.toString()).toBe("");
  expect(success.stdout.toString()).toBe(JSON.stringify(plan({ tasks: [] })) + "\n");
  const cases: [string[], RegExp][] = [
    [[], /Usage/], [["unknown"], /Usage/], [["plan", "--help"], /Usage/],
    [["plan", "file", "--extra"], /Usage/],
    [["plan", `${fixtureDir}/missing.json`], /ENOENT|No such file/],
    [["plan", fixture("{")], /Invalid JSON/],
    [["plan", fixture('{"tasks":{}}')], /tasks/],
    [["plan", fixture('{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":1,"dependsOn":["a"]}]}')], /a -> b -> a/],
  ];
  for (const [args, error] of cases) {
    const result = cli(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toMatch(error);
  }
});

test("long chains and cycles do not overflow the call stack", () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => ({
    id: `n${i}`, duration: 1, dependsOn: i ? [`n${i - 1}`] : [],
  }));
  const result = plan({ tasks });
  expect(result.totalDuration).toBe(tasks.length);
  expect(result.criticalPath.length).toBe(tasks.length);
  tasks[0]!.dependsOn = [tasks[tasks.length - 1]!.id];
  expect(() => plan({ tasks })).toThrow(/Cycle detected: n0 -> n1/);
});

test("random small DAGs match exhaustive chain and scheduling oracles", () => {
  let seed = 123456;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 150; trial++) {
    const ids = ["z", "a", "m", "b", "y", "c"];
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4),
      dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    const result = plan({ tasks: [...tasks].reverse() });
    let best = -1;
    let bestPath: string[] = [];
    const visit = (path: string[], duration: number) => {
      if (duration > best || (duration === best && compare(path, bestPath) < 0)) {
        best = duration;
        bestPath = path;
      }
      for (const task of tasks) {
        if (task.dependsOn.includes(path[path.length - 1]!)) visit([...path, task.id], duration + task.duration);
      }
    };
    for (const task of tasks) visit([task.id], task.duration);
    expect(result.totalDuration).toBe(best);
    expect(result.criticalPath).toEqual(bestPath);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d))).map((t) => t.id).sort();
      expect(id).toBe(ready[0]);
      done.add(id);
    }
    const completed = new Set<string>();
    for (const layer of result.layers) {
      expect(layer).toEqual(tasks.filter((t) => !completed.has(t.id) && t.dependsOn.every((d) => completed.has(d))).map((t) => t.id).sort());
      for (const id of layer) completed.add(id);
    }
    for (const task of tasks) {
      const start = Math.max(0, ...task.dependsOn.map((d) => result.earliest[d]!.finish));
      expect(result.earliest[task.id]).toEqual({ start, finish: start + task.duration });
    }
    expect(plan({ tasks })).toEqual(result);
  }
});
