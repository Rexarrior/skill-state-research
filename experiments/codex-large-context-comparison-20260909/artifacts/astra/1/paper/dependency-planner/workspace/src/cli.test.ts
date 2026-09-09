import { describe, expect, test } from "bun:test";
import { plan } from "./cli";
const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

describe("planner", () => {
  test("empty", () => {
    expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  });
  test("ready priority, layers, disconnected scheduling", () => {
    expect(plan({ tasks: [task("z", 2), task("b", 3, ["a"]), task("a", 1), task("c", 2, ["b", "z"])] })).toEqual({
      order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
      earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 6 } },
      totalDuration: 6, criticalPath: ["a", "b", "c"]
    });
  });
  test("full sequence ties and zero prefixes/suffixes", () => {
    expect(plan({ tasks: [task("a", 1), task("b", 0, ["a"]), task("z", 2, ["a", "b"]), task("zz", 0, ["z"])] }).criticalPath).toEqual(["a", "b", "z"]);
    expect(plan({ tasks: [task("a", 0), task("z", 1, ["a"])] }).criticalPath).toEqual(["a", "z"]);
    expect(plan({ tasks: [task("z", 0), task("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  });
  test("special object keys and default dependencies", () => {
    const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, task("constructor", 1, ["__proto__"])] });
    expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
    expect(result.totalDuration).toBe(3);
  });
  test("deterministic concrete cycles", () => {
    for (const tasks of [[task("b", 1, ["a"]), task("a", 1, ["b"])], [task("a", 1, ["b"]), task("b", 1, ["a"])]]) {
      expect(() => plan({ tasks })).toThrow("a -> b -> a");
    }
  });
  test("invalid schemas", () => {
    for (const value of [null, [], {}, { tasks: {} }, ...[
      [null], [task("")], [task("a"), task("a")], [task("a", -1)], [task("a", Infinity)],
      [{ id: "a", duration: "1" }], [task("a", 1, ["missing"])], [task("a", 1, ["a"])],
      [task("a"), task("b", 1, ["a", "a"])], [{ id: "a", duration: 1, dependsOn: null }],
      [{ id: "a", duration: 1, dependsOn: [1] }]
    ].map(tasks => ({ tasks }))]) expect(() => plan(value)).toThrow();
  });
  test("critical path matches exhaustive chains on small random DAGs", () => {
    let seed = 123;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let trial = 0; trial < 100; trial++) {
      const ids = ["f", "a", "d", "b", "e", "c"];
      const tasks = ids.map((id, i) => task(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < .35)));
      const chains: { path: string[]; duration: number }[] = [];
      function walk(path: string[], duration: number) {
        chains.push({ path, duration });
        for (const t of tasks.filter(t => t.dependsOn.includes(path[path.length - 1]))) walk([...path, t.id], duration + t.duration);
      }
      for (const t of tasks) walk([t.id], t.duration);
      const maximum = Math.max(...chains.map(c => c.duration));
      const best = chains.filter(c => c.duration === maximum).sort((a, b) => {
        for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
          if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i] ? -1 : 1;
        }
        return a.path.length - b.path.length;
      })[0];
      const result = plan({ tasks: tasks.reverse() });
      expect(result.totalDuration).toBe(maximum);
      expect(result.criticalPath).toEqual(best.path);
    }
  });
});

test("CLI output and failures", async () => {
  const file = `${import.meta.dir}/.test-input-${process.pid}.json`;
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "run", `${import.meta.dir}/cli.ts`, ...args]);
  try {
    await Bun.write(file, JSON.stringify({ tasks: [task("a", 2)] }));
    const ok = run("plan", file);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toBe("");
    expect(JSON.parse(ok.stdout.toString()).totalDuration).toBe(2);
    expect(ok.stdout.toString().trim().split("\n")).toHaveLength(1);
    for (const args of [[], ["other", file], ["plan", file, "--extra"], ["plan", "--bad"], ["plan", `${file}.missing`]]) {
      const result = run(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(result.stdout.length).toBe(0);
    }
    for (const content of ["{", '{"tasks":null}', JSON.stringify({ tasks: [task("a", 1, ["b"]), task("b", 1, ["a"])] })]) {
      await Bun.write(file, content);
      const result = run("plan", file);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  } finally {
    await Bun.file(file).delete();
  }
});
