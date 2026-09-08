import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plan, type Task } from "../src/planner";

test("empty graph", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test("lexical readiness, earliest layers, parallel timing and disconnected tasks", () => {
  expect(plan({ tasks: [
    { id: "z", duration: 2 },
    { id: "b", duration: 4, dependsOn: ["a"] },
    { id: "c", duration: 2, dependsOn: ["z", "b"] },
    { id: "a", duration: 1 },
  ] })).toEqual({
    order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 5 }, z: { start: 0, finish: 2 }, c: { start: 5, finish: 7 } },
    totalDuration: 7, criticalPath: ["a", "b", "c"],
  });
});

test("critical ties compare full sequences rather than immediate parents", () => {
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "b", duration: 1 },
    { id: "z", duration: 1, dependsOn: ["a"] },
    { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "end", duration: 1, dependsOn: ["z", "c"] },
  ] }).criticalPath).toEqual(["a", "z", "end"]);
});

test("zero-duration paths and prefix ties", () => {
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 2, dependsOn: ["z"] }] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [
    { id: "a", duration: 1 }, { id: "b", duration: 0, dependsOn: ["a"] },
    { id: "z", duration: 1, dependsOn: ["a", "b"] },
    { id: "end", duration: 0, dependsOn: ["z"] },
  ] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [{ id: "z", duration: 0 }, { id: "a", duration: 0, dependsOn: ["z"] }] }).criticalPath).toEqual(["a"]);
});

test("special object keys are preserved safely", () => {
  const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, { id: "constructor", duration: 1, dependsOn: ["__proto__"] }] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});

describe("validation", () => {
  const invalid: unknown[] = [null, [], {}, { tasks: null }, { tasks: [null] },
    { tasks: [{ id: "", duration: 1 }] }, { tasks: [{ id: 1, duration: 1 }] },
    ...[-1, NaN, Infinity, "1", null, undefined].map((duration) => ({ tasks: [{ id: "a", duration }] })),
    ...[null, "a", [1], ["b", "b"], ["a"], ["missing"]].map((dependsOn) => ({ tasks: [{ id: "a", duration: 1, dependsOn }] })),
    { tasks: [{ id: "a", duration: 1 }, { id: "a", duration: 2 }] },
  ];
  for (const [index, input] of invalid.entries()) test(`invalid schema ${index}`, () => expect(() => plan(input)).toThrow());
});

test("cycle reports are concrete and independent of input ordering", () => {
  const tasks = [
    { id: "z", duration: 1 },
    { id: "c", duration: 1, dependsOn: ["b"] },
    { id: "b", duration: 1, dependsOn: ["c", "a"] },
    { id: "a", duration: 1, dependsOn: ["b"] },
  ];
  for (const input of [tasks, [...tasks].reverse()]) {
    expect(() => plan({ tasks: input })).toThrow("Cycle detected: a -> b -> a");
  }
});

test("deep graphs do not depend on recursive call stacks", () => {
  const tasks = Array.from({ length: 15000 }, (_, index) => ({
    id: `n${index}`, duration: 1, dependsOn: index ? [`n${index - 1}`] : [],
  }));
  expect(plan({ tasks }).totalDuration).toBe(15000);
  tasks[0]!.dependsOn = [tasks[tasks.length - 1]!.id];
  expect(() => plan({ tasks })).toThrow("Cycle detected:");
});

test("generated DAGs agree with exhaustive chain enumeration", () => {
  let seed = 123456;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const compare = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let run = 0; run < 200; run++) {
    const ids = ["z", "a", "y", "b", "x", "c", "w"];
    const tasks: Task[] = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.35) }));
    let bestDuration = -1;
    let best: string[] = [];
    const visit = (task: Task, path: string[], duration: number) => {
      path = [...path, task.id];
      duration += task.duration;
      if (duration > bestDuration || (duration === bestDuration && compare(path, best) < 0)) {
        bestDuration = duration;
        best = path;
      }
      for (const child of tasks) if (child.dependsOn.includes(task.id)) visit(child, path, duration);
    };
    for (const task of tasks) visit(task, [], 0);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(bestDuration);
    expect(result.criticalPath).toEqual(best);
    expect(plan({ tasks: [...tasks].reverse().map((task) => ({ ...task, dependsOn: [...task.dependsOn].reverse() })) })).toEqual(result);
    const pending = new Set(ids);
    const done = new Set<string>();
    for (const id of result.order) {
      const available = tasks.filter((task) => pending.has(task.id) && task.dependsOn.every((dep) => done.has(dep))).map((task) => task.id).sort();
      expect(id).toBe(available[0]);
      pending.delete(id);
      done.add(id);
    }
  }
});

test("CLI success and failures use the right output streams and exit codes", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".planner-test-"));
  const invoke = (args: string[]) => Bun.spawnSync([process.execPath, "run", "src/cli.ts", ...args], { cwd: process.cwd() });
  try {
    const valid = join(directory, "valid.json");
    const malformed = join(directory, "malformed.json");
    const invalid = join(directory, "invalid.json");
    const cycle = join(directory, "cycle.json");
    await writeFile(valid, '{"tasks":[{"id":"build","duration":3}]}');
    await writeFile(malformed, "{");
    await writeFile(invalid, '{"tasks":false}');
    await writeFile(cycle, '{"tasks":[{"id":"a","duration":0,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}');
    const success = invoke(["plan", valid]);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString()).criticalPath).toEqual(["build"]);
    for (const [args, message] of [
      [[], "command"], [["other", valid], "command"], [["plan"], "input file"],
      [["plan", valid, "extra"], "input file"], [["plan", valid, "--help"], "Unknown flag"],
      [["plan", malformed], "Invalid JSON"], [["plan", invalid], "tasks"],
      [["plan", join(directory, "missing.json")], "Cannot read"],
      [["plan", cycle], "a -> b -> a"],
    ] as [string[], string][]) {
      const result = invoke(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(message);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
