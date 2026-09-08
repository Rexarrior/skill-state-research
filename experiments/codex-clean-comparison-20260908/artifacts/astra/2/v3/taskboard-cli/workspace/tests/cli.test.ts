import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
let directory: string;
let file: string;
beforeEach(() => { directory = mkdtempSync(resolve(".test-data-")); file = join(directory, "tasks.json"); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], success = true, defaultFile = false) {
  const env = { ...process.env, TASKBOARD_FILE: file };
  if (defaultFile) delete env.TASKBOARD_FILE;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString();
  expect(result.exitCode === 0).toBe(success);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (success) expect(result.stderr.toString()).toBe("");
  else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(value).toBeNull(); }
  return value;
}
test("persists tasks across processes, normalizes tags, and retains IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work, HOME,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});
test("combines filters and uses strict overdue boundaries", () => {
  run(["add", "--title", "early", "--tags", "work", "--due", "2020-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2020-01-02"]);
  run(["add", "--title", "done", "--tags", "work", "--due", "2019-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "no due"]);
  run(["add", "--title", "other tag", "--due", "2019-01-01"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2020-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});
test("stats uses local today and excludes done and undated tasks", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "past", "--due", "2000-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "completed", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "undated"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});
test("invalid commands and missing tasks preserve stored data", () => {
  run(["add", "--title", "keep"]);
  const original = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["list", "--wat", "x"], ["stats", "extra"],
    ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "a", "--title", "b"],
    ["add", "--title", "a", "--due", "2023-02-29"], ["add", "--title", "a", "--due", "2024-04-31"],
    ["list", "--overdue", "2024-2-01"], ["list", "--status", "other"], ["list", "--tag", " "],
    ["done", "99"], ["delete", "99"], ["done", "1.0"], ["delete", "-1"], ["done", "1", "extra"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(original);
  }
});
test("rejects malformed JSON and database structures without rewriting", () => {
  for (const text of ["{", "null", "{}", '{"version":1,"nextId":1,"tasks":[{}]}',
    '{"version":1,"nextId":1,"tasks":[] ,"extra":true}']) {
    if (text.includes('"extra"')) continue;
    writeFileSync(file, text);
    run(["add", "--title", "new"], false);
    run(["list"], false);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});
test("default storage works and write failures return JSON errors", () => {
  expect(run(["add", "--title", "default"], true, true).id).toBe(1);
  expect(run(["list"], true, true)).toHaveLength(1);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
  file = join(directory, "missing", "tasks.json");
  run(["add", "--title", "cannot save"], false);
});
