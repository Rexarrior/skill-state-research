import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(resolve(".test-taskboard-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], success = true, defaultFile = false) {
  const env = { ...process.env, TZ: "Pacific/Honolulu" };
  delete env.TASKBOARD_FILE;
  if (!defaultFile) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const output = result.stdout.toString();
  expect(result.exitCode === 0).toBe(success);
  expect(output.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(output);
  if (success) expect(result.stderr.toString()).toBe("");
  else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(value).toBeNull(); }
  return value;
}

test("separate processes persist tasks, normalize tags, complete idempotently, and never reuse IDs", () => {
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", "  Ship  ", "--tags", " Work,work, ,HOME,home ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "Ship", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const stored = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(stored);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["list"])).toEqual([]);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine, overdue is strict and open-only, output is sorted", () => {
  run(["add", "--title", "Earlier", "--tags", "work", "--due", "2024-02-28"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-02-29"]);
  run(["add", "--title", "Other tag", "--tags", "home", "--due", "2024-02-27"]);
  run(["add", "--title", "Done", "--tags", "work", "--due", "2024-02-26"]);
  run(["done", "4"]);
  run(["add", "--title", "Undated", "--tags", "work"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map(t => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-02-29"]).map(t => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-02-29"]).map(t => t.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2024-02-29"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map(t => t.id)).toEqual([4]);
});

test("stats uses local date and excludes today's and completed tasks", () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Honolulu", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "Past", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Future", "--due", "9999-12-31"]);
  run(["add", "--title", "Completed", "--due", "2000-01-01"]);
  run(["done", "4"]);
  run(["add", "--title", "Undated"]);
  expect(run(["stats"])).toEqual({ total: 5, open: 4, done: 1, overdue: 1 });
});

test("invalid commands and arguments fail without changing data", () => {
  run(["add", "--title", "Keep"]);
  const original = readFileSync(file, "utf8");
  const invalid = [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "a", "--bogus", "x"], ["add", "--title", "a", "--title", "b"], ["list", "extra"], ["list", "--status", "invalid"], ["list", "--tag", " "], ["list", "--overdue", "2023-02-29"], ["stats", "--tag", "x"], ["done", "99"], ["delete", "99"], ["done", "0"], ["delete", "-1"], ["done", "1.5"], ["done", "1", "2"], ["delete", "9007199254740992"]];
  for (const due of ["2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-01", "not-a-date"]) invalid.push(["add", "--title", "Invalid", "--due", due]);
  for (const args of invalid) { run(args, false); expect(readFileSync(file, "utf8")).toBe(original); }
});

test("malformed JSON and corrupt database structures are preserved", () => {
  const task = run(["add", "--title", "Keep"]);
  const db = { version: 1, nextId: 2, tasks: [task] };
  const bad = ["{", "null", "[]", "{}", JSON.stringify({ ...db, nextId: 1 }), JSON.stringify({ ...db, tasks: [task, task] })];
  for (const patch of [{ status: "unknown" }, { due: "2023-02-29" }, { tags: ["A"] }, { tags: ["a", "a"] }, { title: "" }, { createdAt: "invalid" }, { status: "done" }, { id: -1 }]) bad.push(JSON.stringify({ ...db, tasks: [{ ...task, ...patch }] }));
  for (const text of bad) {
    writeFileSync(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "Overwrite"], ["done", "1"], ["delete", "1"]]) { run(args, false); expect(readFileSync(file, "utf8")).toBe(text); }
  }
});

test("default path persists and missing parent fails cleanly", () => {
  run(["add", "--title", "Default"], true, true);
  expect(run(["list"], true, true)[0].title).toBe("Default");
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
  file = join(directory, "missing", "tasks.json");
  run(["add", "--title", "Cannot save"], false);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});
