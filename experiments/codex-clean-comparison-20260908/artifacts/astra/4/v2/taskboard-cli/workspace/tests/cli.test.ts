import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const entry = resolve("src/cli.ts");
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(".test-taskboard-")); file = join(dir, "tasks.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function cli(args: string[], ok = true, defaultFile = false, tz?: string) {
  const env = { ...process.env, TASKBOARD_FILE: file, ...(tz ? { TZ: tz } : {}) };
  if (defaultFile) delete env.TASKBOARD_FILE;
  const result = Bun.spawnSync([process.execPath, "run", entry, ...args], { cwd: dir, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) { expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe(""); }
  else { expect(result.exitCode).not.toBe(0); expect(result.stderr.toString().trim().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
  return value;
}
test("separate processes persist tasks, normalize tags, complete idempotently, and never reuse IDs", () => {
  expect(cli(["list"])).toEqual([]);
  const task = cli(["add", "--title", "  Ship release  ", "--tags", " Work,work,, RELEASE ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "Ship release", status: "open", tags: ["work", "release"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(cli(["list"])).toEqual([task]);
  const done = cli(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const saved = readFileSync(file, "utf8");
  expect(cli(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(saved);
  expect(cli(["delete", "1"])).toEqual(done);
  expect(cli(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
});
test("list sorts IDs and combines filters with strict open-only overdue", () => {
  cli(["add", "--title", "Early", "--tags", "work", "--due", "2024-02-28"]);
  cli(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-02-29"]);
  cli(["add", "--title", "Other", "--tags", "home", "--due", "2024-02-27"]);
  cli(["add", "--title", "Finished", "--tags", "work", "--due", "2024-02-26"]);
  cli(["done", "4"]);
  cli(["add", "--title", "Undated", "--tags", "work"]);
  const db = JSON.parse(readFileSync(file, "utf8")); db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(cli(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(cli(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-02-29"]).map((t: any) => t.id)).toEqual([1]);
  expect(cli(["list", "--overdue", "2024-02-29"]).map((t: any) => t.id)).toEqual([1, 3]);
  expect(cli(["list", "--status", "done", "--overdue", "2024-02-29"])).toEqual([]);
});
test("invalid arguments and missing tasks leave database bytes intact", () => {
  cli(["add", "--title", "Keep"]);
  const saved = readFileSync(file, "utf8");
  const invalid = [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"], ["add", "--title", "x", "--due", "2024-2-01"], ["list", "--status", "closed"], ["list", "--overdue", "bad"], ["list", "--tag", " "], ["list", "--unknown", "x"], ["list", "--tag"], ["add", "--title", "a", "--title", "b"], ["stats", "extra"], ["done", "1.5"], ["delete", "0"], ["done", "999"], ["delete", "999"], ["done", "1", "extra"]];
  for (const args of invalid) { cli(args, false); expect(readFileSync(file, "utf8")).toBe(saved); }
});
test("malformed JSON and invalid database records are never overwritten", () => {
  const task = cli(["add", "--title", "Keep"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2025-02-29" }] }), JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }), JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, status: "done" }] }), JSON.stringify({ version: 1, nextId: 1, tasks: [task] })];
  for (const text of invalid) { writeFileSync(file, text); for (const args of [["list"], ["add", "--title", "Replacement"]]) { cli(args, false); expect(readFileSync(file, "utf8")).toBe(text); } }
});
test("default storage survives processes", () => {
  const task = cli(["add", "--title", "Default"], true, true);
  expect(cli(["list"], true, true)).toEqual([task]);
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
});
test("stats uses today's local date and excludes done and undated tasks", () => {
  const tz = "Pacific/Kiritimati";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  cli(["add", "--title", "Past", "--due", "2000-01-01"]);
  cli(["add", "--title", "Today", "--due", today]);
  cli(["add", "--title", "Done", "--due", "2000-01-01"]);
  cli(["done", "3"]);
  cli(["add", "--title", "Undated"]);
  expect(cli(["stats"], true, false, tz)).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});
test("failed writes report one JSON error and leave no temporary files", () => {
  file = join(dir, "missing", "tasks.json");
  cli(["add", "--title", "Cannot save"], false);
  expect(readdirSync(dir)).toEqual([]);
});
