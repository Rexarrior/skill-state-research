import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
function fixture(run: (dir: string, file: string, invoke: (args: string[], ok?: boolean, defaultFile?: boolean) => any) => void) {
  const dir = mkdtempSync(resolve(".test-taskboard-"));
  const file = join(dir, "tasks.json");
  try {
    run(dir, file, (args, ok = true, defaultFile = false) => {
      const env = { ...process.env };
      delete env.TASKBOARD_FILE;
      if (!defaultFile) env.TASKBOARD_FILE = file;
      const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
      expect(result.exitCode === 0).toBe(ok);
      const output = result.stdout.toString().trim();
      expect(output.split("\n")).toHaveLength(1);
      const value = JSON.parse(output);
      if (ok) expect(result.stderr.toString()).toBe("");
      else { expect(value).toBeNull(); expect(result.stderr.toString().length).toBeGreaterThan(0); }
      return value;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("persistence, normalization, filtering, completion, deletion and stats", () => fixture((dir, file, invoke) => {
  expect(invoke(["list"])).toEqual([]);
  const first = invoke(["add", "--title", " First ", "--tags", " Work,work,URGENT,, ", "--due", "2000-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2000-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  invoke(["add", "--title", "Second", "--due", "9999-12-31"]);
  invoke(["add", "--title", "Third"]);
  expect(invoke(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3]);
  expect(invoke(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2000-03-01"])).toEqual([first]);
  expect(invoke(["list", "--overdue", "2000-02-29"])).toEqual([]);
  expect(invoke(["stats"])).toEqual({ total: 3, open: 3, done: 0, overdue: 1 });
  const done = invoke(["done", "1"]);
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(invoke(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(invoke(["list", "--status", "done", "--overdue", "2020-01-01"])).toEqual([]);
  expect(invoke(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 0 });
  expect(invoke(["delete", "3"]).id).toBe(3);
  expect(invoke(["add", "--title", "Fourth"]).id).toBe(4);
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
}));

test("invalid inputs preserve data", () => fixture((_dir, file, invoke) => {
  invoke(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  const invalid = [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--due", "2025-02-29"], ["add", "--title", "x", "--due", "2026-04-31"],
    ["add", "--title", "x", "--title", "y"], ["list", "--wat", "x"], ["list", "--status", "other"],
    ["list", "--overdue", "2026-13-01"], ["list", "--tag", " "], ["stats", "extra"],
    ["done", "0"], ["done", "1.0"], ["done", "999"], ["delete", "999"], ["delete", "1", "extra"]];
  for (const args of invalid) { invoke(args, false); expect(readFileSync(file, "utf8")).toBe(before); }
}));

test("malformed JSON and database structures are never replaced", () => fixture((_dir, file, invoke) => {
  const task = invoke(["add", "--title", "Keep"]);
  for (const text of ["{broken", "null", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2026-02-30" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] })]) {
    writeFileSync(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"]]) {
      invoke(args, false); expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
}));

test("default storage survives separate processes", () => fixture((dir, _file, invoke) => {
  invoke(["add", "--title", "Default"], true, true);
  expect(invoke(["list"], true, true)[0].title).toBe("Default");
  expect(JSON.parse(readFileSync(join(dir, ".taskboard.json"), "utf8")).tasks).toHaveLength(1);
}));
