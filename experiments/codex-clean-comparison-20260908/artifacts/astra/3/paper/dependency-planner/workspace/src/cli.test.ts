import { describe, expect, test } from "bun:test";
import { plan } from "./cli";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const t = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

describe("planner", () => {
  test("empty graph", () => {
    expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  });
  test("ready ordering, earliest layers, parallel timing and disconnected components", () => {
    expect(plan({ tasks: [t("z", 2), t("b", 4, ["a"]), t("a", 3), t("c", 2, ["b", "z"])] })).toEqual({
      order: ["a", "b", "z", "c"], layers: [["a", "z"], ["b"], ["c"]],
      earliest: { a: { start: 0, finish: 3 }, b: { start: 3, finish: 7 }, z: { start: 0, finish: 2 }, c: { start: 7, finish: 9 } },
      totalDuration: 9, criticalPath: ["a", "b", "c"],
    });
  });
  test("full sequence ties including zero-duration prefixes", () => {
    const tasks = [t("a", 0), t("b", 1, ["a"]), t("z", 1, ["a", "b"]), t("c", 1, ["a"])];
    expect(plan({ tasks }).criticalPath).toEqual(["a", "b", "z"]);
    expect(plan({ tasks: [t("a", 1), t("b", 0, ["a"]), t("z", 1, ["a", "b"])] }).criticalPath).toEqual(["a", "b", "z"]);
    expect(plan({ tasks: [t("a", 1), t("b", 0, ["a"])] }).criticalPath).toEqual(["a"]);
    expect(plan({ tasks: [t("z", 0), t("a", 0, ["z"])] }).criticalPath).toEqual(["a"]);
  });
  test("prototype-like ids and default dependencies", () => {
    const result = plan({ tasks: [{ id: "__proto__", duration: 2 }, t("constructor", 1, ["__proto__"])] });
    expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
    expect(result.totalDuration).toBe(3);
  });
  test("cycle is concrete and independent of input order", () => {
    const tasks = [t("b", 1, ["a"]), t("a", 1, ["b"]), t("c")];
    for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow("a -> b -> a");
  });
  test("schema validation", () => {
    for (const input of [null, [], {}, { tasks: null }, { tasks: [null] },
      { tasks: [t("")] }, { tasks: [t("a"), t("a")] },
      ...[-1, NaN, Infinity, "1", null].map(duration => ({ tasks: [{ id: "a", duration }] })),
      ...[null, "b", [1], ["b", "b"], ["missing"], ["a"]].map(dependsOn => ({ tasks: [{ id: "a", duration: 1, dependsOn }, t("b")] })),
    ]) expect(() => plan(input)).toThrow();
  });
  test("small DAGs agree with exhaustive chain enumeration", () => {
    let seed = 123;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const compare = (a: string[], b: string[]) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
      return a.length - b.length;
    };
    for (let run = 0; run < 100; run++) {
      const ids = ["f", "a", "d", "b", "e", "c"];
      const tasks = ids.map((id, i) => t(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < 0.4)));
      const paths: { path: string[]; duration: number }[] = [];
      function visit(task: ReturnType<typeof t>, path: string[], duration: number) {
        const next = { path: [...path, task.id], duration: duration + task.duration };
        paths.push(next);
        for (const child of tasks.filter(child => child.dependsOn.includes(task.id))) visit(child, next.path, next.duration);
      }
      for (const task of tasks) visit(task, [], 0);
      paths.sort((a, b) => b.duration - a.duration || compare(a.path, b.path));
      const result = plan({ tasks });
      expect(result.totalDuration).toBe(paths[0]!.duration);
      expect(result.criticalPath).toEqual(paths[0]!.path);
      expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
    }
  });
});

test("CLI success and failures", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".planner-test-"));
  const file = join(dir, "input.json");
  const run = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  try {
    await writeFile(file, JSON.stringify({ tasks: [t("a")] }));
    const ok = await run(["plan", file]);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe("");
    expect(ok.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(ok.stdout).totalDuration).toBe(1);
    for (const args of [[], ["oops", file], ["plan", file, "--foo"], ["plan", "--foo"], ["plan", join(dir, "missing")]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeGreaterThan(0);
    }
    for (const text of ["{", '{"tasks":false}', JSON.stringify({ tasks: [t("a", 1, ["b"]), t("b", 1, ["a"])] })]) {
      await writeFile(file, text);
      const result = await run(["plan", file]);
      expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(result.stderr.length).toBeGreaterThan(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
