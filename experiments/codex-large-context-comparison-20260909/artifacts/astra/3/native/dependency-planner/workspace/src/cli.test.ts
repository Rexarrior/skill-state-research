import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { plan } from "./cli";

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test("parallel schedule, disconnected component, and lexicographic ready selection", () => {
  expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 2, ["a"]), task("d", 1, ["b", "c"])] })).toEqual({
    order: ["a", "b", "c", "d", "z"],
    layers: [["a", "z"], ["b", "c"], ["d"]],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, c: { start: 1, finish: 3 }, d: { start: 4, finish: 5 }, z: { start: 0, finish: 2 } },
    totalDuration: 5,
    criticalPath: ["a", "b", "d"],
  });
});

test("empty graph and default dependencies", () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(plan({ tasks: [{ id: "a", duration: 0 }] }).criticalPath).toEqual(["a"]);
});

test("full sequence ties, zero-duration prefixes and suffixes", () => {
  expect(plan({ tasks: [task("a", 1), task("b", 0, ["a"]), task("z", 1, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "z"]);
  expect(plan({ tasks: [task("z", 0), task("a", 2, ["z"]), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 0), task("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
  expect(plan({ tasks: [task("a", 1), task("z", 1, ["a"]), task("b", 1), task("c", 1, ["b"])] }).criticalPath).toEqual(["a", "z"]);
});

test("special object keys and fractional duration", () => {
  const result = plan({ tasks: [task("__proto__", 0.25), task("constructor", 0.5, ["__proto__"]), task("toString", 0, ["constructor"])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.25 });
  expect(result.totalDuration).toBe(0.75);
});

describe("validation", () => {
  const cases: [unknown, string][] = [
    [null, "tasks"], [{}, "tasks"], [{ tasks: {} }, "tasks"],
    [{ tasks: [null] }, "id"], [{ tasks: [task("")] }, "id"],
    [{ tasks: [task("a"), task("a")] }, "Duplicate"],
    ...[-1, Infinity, NaN, "3", null, undefined].map((duration): [unknown, string] => [{ tasks: [{ id: "a", duration }] }, "duration"]),
    ...[null, "a", [1], ["a", "a"]].map((dependsOn): [unknown, string] => [{ tasks: [{ id: "b", duration: 1, dependsOn }] }, "dependsOn"]),
    [{ tasks: [task("a", 1, ["missing"])] }, "unknown dependency"],
    [{ tasks: [task("a", 1, ["a"])] }, "a -> a"],
    [{ tasks: [task("a", Number.MAX_VALUE), task("b", Number.MAX_VALUE, ["a"])] }, "finite number range"],
  ];
  for (const [index, [input, message]] of cases.entries()) {
    test(`invalid case ${index}`, () => expect(() => plan(input)).toThrow(message));
  }
});

test("cycles are concrete and stable across input permutations", () => {
  const tasks = [task("z"), task("c", 1, ["b"]), task("b", 1, ["a", "c"]), task("a", 1, ["b"])];
  for (const input of [tasks, [...tasks].reverse()]) {
    expect(() => plan({ tasks: input })).toThrow("Dependency cycle: a -> b -> a");
  }
});

test("long graphs do not rely on recursive traversal", () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(tasks.length);
  tasks[0].dependsOn = [String(tasks.length - 1)];
  expect(() => plan({ tasks })).toThrow("Dependency cycle:");
});

test("generated DAGs agree with exhaustive chain enumeration", () => {
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 200; trial++) {
    const ids = ["g", "c", "a", "e", "b", "f", "d"];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 4), ids.slice(0, i).filter(() => random() < 0.35)));
    const chains: { path: string[]; duration: number }[] = [];
    const visit = (path: string[], duration: number) => {
      chains.push({ path, duration });
      for (const next of tasks.filter((t) => t.dependsOn.includes(path[path.length - 1]))) visit([...path, next.id], duration + next.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    chains.sort((a, b) => b.duration - a.duration || comparePaths(a.path, b.path));
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.criticalPath).toEqual(chains[0].path);
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(plan({ tasks })).toEqual(result);
    const done = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d))).map((t) => t.id).sort();
      expect(id).toBe(ready[0]);
      done.add(id);
    }
    for (const t of tasks) {
      const start = Math.max(0, ...t.dependsOn.map((id) => result.earliest[id].finish));
      expect(result.earliest[t.id]).toEqual({ start, finish: start + t.duration });
      const level = result.layers.findIndex((layer) => layer.includes(t.id));
      expect(level).toBe(Math.max(-1, ...t.dependsOn.map((id) => result.layers.findIndex((layer) => layer.includes(id)))) + 1);
    }
  }
});

test("CLI emits only JSON on success and useful stderr on failure", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".cli-test-"));
  const run = async (args: string[]) => {
    const process = Bun.spawn([Bun.which("bun")!, "run", "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const file = join(directory, "input.json");
    await writeFile(file, JSON.stringify({ tasks: [task("a", 2)] }));
    const success = await run(["plan", file]);
    expect(success.code).toBe(0);
    expect(success.stderr).toBe("");
    expect(success.stdout.split("\n")).toHaveLength(2);
    expect(JSON.parse(success.stdout).totalDuration).toBe(2);
    for (const args of [[], ["unknown", file], ["plan"], ["plan", file, "--extra"], ["plan", "--help"], ["plan", join(directory, "missing.json")]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    for (const [content, message] of [["{", "Invalid JSON"], ['{"tasks":null}', "tasks"], [JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] }), "a -> b -> a"]]) {
      await writeFile(file, content);
      const result = await run(["plan", file]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
