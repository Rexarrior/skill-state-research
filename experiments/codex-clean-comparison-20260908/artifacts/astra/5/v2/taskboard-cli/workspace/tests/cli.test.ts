import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(import.meta.dir, "../.taskboard-tests-")); file = join(dir, "db.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(args: string[], ok = true, custom = true) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (custom) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  const stdout = result.stdout.toString().trim();
  expect(stdout.split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  expect(result.exitCode === 0).toBe(ok);
  if (ok) expect(result.stderr.toString()).toBe("");
  else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
  return value;
}
test("persists, normalizes, completes idempotently, deletes without ID reuse", () => {
  const task = run(["add", "--title", "  First  ", "--tags", " Work,work, HOME,, ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First", tags: ["work", "home"], status: "open", due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const completed = run(["done", "1"]);
  expect(completed.status).toBe("done");
  expect(new Date(completed.completedAt).toISOString()).toBe(completed.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(completed);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(completed);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["db.json"]);
});
test("filters combine, overdue is strict and excludes done, sorting is by ID", () => {
  run(["add", "--title", "old", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "finished", "--tags", "work", "--due", "2023-01-01"]);
  run(["add", "--title", "no due"]);
  run(["done", "3"]);
  const db = JSON.parse(readFileSync(file, "utf8")); db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
});
test("stats uses local today and excludes due today and completed tasks", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "old", "--due", "0001-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "done", "--due", "0001-01-01"]);
  run(["done", "3"]);
  expect(run(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
});
test("bad commands and arguments preserve data", () => {
  run(["add", "--title", "keep"]);
  const original = readFileSync(file, "utf8");
  for (const args of [[], ["unknown"], ["add"], ["add", "--title", "  "], ["add", "--title"], ["add", "--title", "x", "--wat", "x"], ["add", "--title", "x", "--title", "y"], ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-1-01", "garbage"].map(d => ["add", "--title", "x", "--due", d]), ["list", "--status", "bad"], ["list", "--overdue", "2023-02-29"], ["list", "--tag", " "], ["list", "--unknown", "x"], ["stats", "extra"], ["done"], ["done", "1.0"], ["done", "0"], ["done", "9007199254740992"], ["done", "1", "extra"], ["done", "99"], ["delete", "99"]]) {
    run(args, false); expect(readFileSync(file, "utf8")).toBe(original);
  }
});
test("malformed JSON and invalid schemas are never overwritten", () => {
  const task = run(["add", "--title", "valid"]);
  const badTasks = [{ ...task, id: -1 }, { ...task, title: "" }, { ...task, status: "other" }, { ...task, tags: ["A"] }, { ...task, tags: ["a", "a"] }, { ...task, due: "2023-02-29" }, { ...task, createdAt: "bad" }, { ...task, status: "done" }, { ...task, completedAt: new Date().toISOString() }];
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 2, nextId: 1, tasks: [] }), JSON.stringify({ version: 1, nextId: 1, tasks: [task] }), JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }), ...badTasks.map(t => JSON.stringify({ version: 1, nextId: 2, tasks: [t] }))];
  for (const text of invalid) {
    writeFileSync(file, text);
    run(["add", "--title", "replacement"], false);
    run(["list"], false);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});
test("default file and empty database behavior", () => {
  expect(run(["list"], true, false)).toEqual([]);
  expect(run(["stats"], true, false)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  expect(readdirSync(dir)).toEqual([]);
  run(["add", "--title", "default"], true, false);
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
  expect(run(["list"], true, false)).toHaveLength(1);
  expect(run(["list"])).toEqual([]);
});
test("storage failures emit one JSON error without creating directories", () => {
  file = join(dir, "missing", "db.json");
  run(["add", "--title", "unwritable"], false);
  expect(readdirSync(dir)).toEqual([]);
  file = dir;
  run(["list"], false);
});
