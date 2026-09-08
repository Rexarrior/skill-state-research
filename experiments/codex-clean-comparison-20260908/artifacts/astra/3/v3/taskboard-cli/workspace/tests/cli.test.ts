import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(import.meta.dir, ".run-")); file = join(dir, "tasks.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(args: string[], ok = true, custom = true, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.TASKBOARD_FILE;
  if (custom) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) { expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe(""); }
  else { expect(result.exitCode).not.toBe(0); expect(result.stderr.toString().length).toBeGreaterThan(0); expect(value).toBeNull(); }
  return value;
}
test("persists across processes, normalizes tags, and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", " First ", "--tags", " Work,work, HOME,,home ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const text = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
});
test("combines filters and sorts by ID", () => {
  run(["add", "--title", "old", "--tags", "x", "--due", "2020-01-01"]);
  run(["add", "--title", "boundary", "--tags", "x", "--due", "2020-01-02"]);
  run(["add", "--title", "done", "--tags", "x", "--due", "2019-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "undated", "--tags", "y"]);
  const db = JSON.parse(readFileSync(file, "utf8")); db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map(t => t.id)).toEqual([1, 2, 3, 4]);
  expect(run(["list", "--status", "open", "--tag", " X ", "--overdue", "2020-01-02"]).map(t => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
  expect(run(["list", "--tag", "y"]).map(t => t.id)).toEqual([4]);
});
test("stats uses local date and excludes done and boundary tasks", () => {
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "old", "--due", "0001-01-01"]);
  run(["add", "--title", "today", "--due", local]);
  run(["add", "--title", "done", "--due", "0001-01-01"]); run(["done", "3"]);
  run(["add", "--title", "undated"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});
test("invalid commands and input preserve data", () => {
  run(["add", "--title", "keep"]);
  const original = readFileSync(file, "utf8");
  const invalid = [[], ["wat"], ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "x", "--unknown", "y"], ["add", "--title", "x", "--title", "y"], ["list", "--status", "other"], ["list", "--tag", " "], ["list", "--overdue", "2023-02-29"], ["stats", "--bad"], ["done", "999"], ["delete", "999"], ["done", "1x"], ["done", "0"], ["delete", "1", "extra"], ["list", "--tag"]];
  for (const due of ["2023-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "2024-1-01", "not-date"]) invalid.push(["add", "--title", "x", "--due", due]);
  for (const args of invalid) { run(args, false); expect(readFileSync(file, "utf8")).toBe(original); }
});
test("malformed databases are never replaced", () => {
  run(["add", "--title", "keep"]);
  const good = JSON.parse(readFileSync(file, "utf8"));
  const bad = ["{", "null", "[]", "{}", JSON.stringify({ ...good, nextId: 1 }), JSON.stringify({ ...good, tasks: [good.tasks[0], good.tasks[0]] })];
  for (const patch of [{ status: "other" }, { tags: ["X"] }, { due: "2023-02-29" }, { createdAt: "no" }, { status: "done" }, { completedAt: null }, { id: 1.5 }]) bad.push(JSON.stringify({ ...good, tasks: [{ ...good.tasks[0], ...patch }] }));
  for (const text of bad) { writeFileSync(file, text); run(["add", "--title", "new"], false); run(["list"], false); expect(readFileSync(file, "utf8")).toBe(text); }
});
test("default path and write errors", () => {
  expect(run(["stats"], true, false)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "default"], true, false);
  expect(JSON.parse(readFileSync(join(dir, ".taskboard.json"), "utf8")).tasks[0].title).toBe("default");
  file = join(dir, "missing", "tasks.json");
  run(["add", "--title", "fail"], false);
});
