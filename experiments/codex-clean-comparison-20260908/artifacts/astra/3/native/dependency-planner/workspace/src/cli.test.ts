import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, validate, type Task } from "./cli";

const fixtureDir = mkdtempSync(join(process.cwd(), ".planner-tests-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
let fixtureIndex = 0;
function cli(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
function inputFile(content: string): string {
  const path = join(fixtureDir, `${fixtureIndex++}.json`);
  writeFileSync(path, content);
  return path;
}

test("empty input", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("ready queue differs from layers; disconnected and fractional tasks", () => {
  const result = plan({ tasks: [
    { id: "z", duration: 1.5 },
    { id: "b", duration: 2, dependsOn: ["a"] },
    { id: "a", duration: 1 },
    { id: "join", duration: 0.5, dependsOn: ["b", "z"] },
  ] });
  expect(result).toEqual({
    order: ["a", "b", "z", "join"],
    layers: [["a", "z"], ["b"], ["join"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 3 }, z: { start: 0, finish: 1.5 }, join: { start: 3, finish: 3.5 } },
    totalDuration: 3.5,
    criticalPath: ["a", "b", "join"],
  });
});

test("critical-path ties compare full sequences, not immediate parents", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "b", duration: 1 }, { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "end", duration: 1, dependsOn: ["c", "z"] },
  ] }).criticalPath).toEqual(["a", "z", "end"]);
});

test("zero-duration prefix ties can change after appending a task", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 },
    { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 2, dependsOn: ["a", "b"] },
    { id: "tail", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [
    { id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a"]);
});

test("special object keys are ordinary ids", () => {
  const result = plan({ tasks: [
    { id: "__proto__", duration: 2 },
    { id: "constructor", duration: 1, dependsOn: ["__proto__"] },
    { id: "toString", duration: 0 },
  ] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.criticalPath).toEqual(["__proto__", "constructor"]);
});

describe("validation", () => {
  const invalid = [
    null, [], {}, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    { tasks: [{ id: "a" }] }, { tasks: [{ id: "a", duration: "1" }] },
    ...[-1, Infinity, NaN].map(duration => ({ tasks: [{ id: "a", duration }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
    ...[null, "a", [1], ["a"], ["missing"], ["b", "b"]].map(dependsOn => ({ tasks: [
      { id: "a", duration: 1, dependsOn }, { id: "b", duration: 0 },
    ] })),
  ];
  for (const [i, input] of invalid.entries()) test(`rejects invalid schema ${i}`, () => expect(() => validate(input)).toThrow());
  test("defaults dependencies", () => expect(validate({ tasks: [{ id: "a", duration: 0 }] })[0].dependsOn).toEqual([]));
  test("finite inputs whose schedule overflows fail usefully", () => {
    expect(() => plan({ tasks: [
      { id: "a", duration: Number.MAX_VALUE },
      { id: "b", duration: Number.MAX_VALUE, dependsOn: ["a"] },
    ] })).toThrow("finite number range");
  });
});

test("cycle diagnostics are concrete and independent of input ordering", () => {
  const tasks = [
    { id: "a", duration: 1, dependsOn: ["c", "b"] },
    { id: "b", duration: 1, dependsOn: ["a"] },
    { id: "c", duration: 1, dependsOn: ["a"] },
    { id: "unrelated", duration: 0 },
  ];
  expect(() => plan({ tasks })).toThrow("Cycle detected: a -> b -> a");
  expect(() => plan({ tasks: tasks.reverse().map(t => ({ ...t, dependsOn: t.dependsOn?.slice().reverse() })) })).toThrow("Cycle detected: a -> b -> a");
});

test("deep graphs do not require recursion", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => ({ id: `n${i}`, duration: 1, dependsOn: i ? [`n${i - 1}`] : [] }));
  expect(plan({ tasks }).criticalPath).toHaveLength(tasks.length);
  tasks[0].dependsOn = [tasks[tasks.length - 1].id];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("seeded DAGs match exhaustive chains and an independent scheduler", () => {
  let seed = 3187;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 200; iteration++) {
    const ids = ["z", "a", "m", "b", "q", "c", "x"];
    const tasks: Task[] = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.3) }));
    const result = plan({ tasks });
    const chains: { path: string[]; duration: number }[] = [];
    const visit = (task: Task, prefix: string[], duration: number) => {
      const path = [...prefix, task.id];
      duration += task.duration;
      chains.push({ path, duration });
      for (const child of tasks.filter(t => t.dependsOn.includes(task.id))) visit(child, path, duration);
    };
    for (const task of tasks) visit(task, [], 0);
    chains.sort((a, b) => b.duration - a.duration || compare(a.path, b.path));
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].path);
    const done = new Set<string>();
    const expectedOrder: string[] = [];
    while (done.size < tasks.length) {
      const next = tasks.filter(t => !done.has(t.id) && t.dependsOn.every(id => done.has(id))).map(t => t.id).sort()[0];
      done.add(next);
      expectedOrder.push(next);
    }
    expect(result.order).toEqual(expectedOrder);
    for (const task of tasks) {
      const longest = Math.max(...chains.filter(c => c.path.at(-1) === task.id).map(c => c.duration));
      expect(result.earliest[task.id]).toEqual({ start: longest - task.duration, finish: longest });
      const depth = Math.max(...chains.filter(c => c.path.at(-1) === task.id).map(c => c.path.length - 1));
      expect(result.layers[depth]).toContain(task.id);
    }
    expect(plan({ tasks: tasks.slice().reverse().map(t => ({ ...t, dependsOn: t.dependsOn.slice().reverse() })) })).toEqual(result);
  }
});

test("CLI prints exactly one JSON line", () => {
  const result = cli(["plan", inputFile('{"tasks":[{"id":"build","duration":3}]}')]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(result.stdout).totalDuration).toBe(3);
});

test("CLI failures use stderr and nonzero status", () => {
  const cases = [
    [], ["unknown"], ["plan"], ["plan", "--help"], ["plan", "file", "--extra"],
    ["plan", join(fixtureDir, "missing.json")],
    ["plan", inputFile("{bad")], ["plan", inputFile('{"tasks":null}')],
    ["plan", inputFile('{"tasks":[{"id":"a","duration":1e400}]}')],
    ["plan", inputFile('{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":1,"dependsOn":["a"]}]}')],
  ];
  for (const args of cases) {
    const result = cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error:");
  }
  expect(cli(cases[6]).stderr).toContain("Invalid JSON");
  expect(cli(cases.at(-1)!).stderr).toContain("a -> b -> a");
});
