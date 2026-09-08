import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(import.meta.dir, ".test-")); file = join(dir, "db.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(args: string[], ok = true, useDefault = false) {
  const env = { ...process.env };
  if (useDefault) delete env.TASKBOARD_FILE;
  else env.TASKBOARD_FILE = file;
  const p = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  const out = p.stdout.toString().trim();
  expect(out.split("\n")).toHaveLength(1);
  expect(p.exitCode === 0).toBe(ok);
  expect(p.stderr.toString().length === 0).toBe(ok);
  return JSON.parse(out);
}
test("persistence, normalized tags, completion, deletion and monotonic IDs", () => {
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", " First ", "--tags", " Work,work, HOME,, ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
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
test("AND filters, strict overdue, sorted results, and local stats", () => {
  run(["add", "--title", "a", "--tags", "work", "--due", "2000-01-01"]);
  run(["add", "--title", "b", "--tags", "home", "--due", "2000-01-02"]);
  run(["add", "--title", "c", "--tags", "work", "--due", "2000-01-01"]);
  run(["done", "3"]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "undated"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1,2,3,4,5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2000-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", today])).toEqual([]);
  expect(run(["stats"])).toEqual({ total: 5, open: 4, done: 1, overdue: 2 });
});
test("invalid input and missing tasks preserve bytes", () => {
  run(["add", "--title", "keep"]);
  const bytes = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["add"], ["add", "--title", " "], ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"], ["list", "--overdue", "2024-13-01"], ["list", "--status", "pending"], ["list", "--wat", "x"], ["list", "--tag"], ["add", "--title", "x", "--title", "y"], ["done", "999"], ["delete", "999"], ["done", "1.0"], ["delete", "1", "--force"], ["stats", "--x"]]) {
    expect(run(args, false).error).toBeString();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});
test("malformed JSON and invalid database schemas fail without writes", () => {
  for (const text of ["{", "null", "{}", '{"nextId":1,"tasks":[null]}', '{"nextId":0,"tasks":[]}', '{"nextId":2,"tasks":[{"id":1,"title":"x","status":"open","createdAt":"bad","tags":[]}]}']) {
    writeFileSync(file, text);
    for (const args of [["list"], ["add", "--title", "x"], ["stats"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
});
test("default location survives separate processes", () => {
  expect(run(["add", "--title", "default"], true, true).id).toBe(1);
  expect(run(["list"], true, true)).toHaveLength(1);
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
});
test("write errors emit a single JSON error", () => {
  file = join(dir, "missing", "db.json");
  expect(run(["add", "--title", "x"], false).error).toBeString();
  expect(readdirSync(dir)).toEqual([]);
});
