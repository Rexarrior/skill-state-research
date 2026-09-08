import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const root = resolve(import.meta.dir, "../.test-data");
let directory: string;
let file: string;

beforeEach(() => {
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(join(root, "run-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], success = true, customFile: string | null = file, timezone?: string) {
  const env = { ...process.env, TZ: timezone ?? process.env.TZ };
  delete env.TASKBOARD_FILE;
  if (customFile !== null) env.TASKBOARD_FILE = customFile;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (success) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString().length).toBeGreaterThan(0);
    expect(value).toBeNull();
  }
  return value;
}

test("persists across processes, normalizes tags, completes idempotently and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work,URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const completed = run(["done", "1"]);
  expect(completed.status).toBe("done");
  expect(new Date(completed.completedAt).toISOString()).toBe(completed.completedAt);
  const contents = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(completed);
  expect(readFileSync(file, "utf8")).toBe(contents);
  expect(run(["delete", "1"])).toEqual(completed);
  expect(run(["add", "--title", "Second"])).toMatchObject({ id: 2, tags: [] });
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine, overdue is strict and excludes done tasks, results sort by ID", () => {
  run(["add", "--title", "early", "--tags", "work", "--due", "2020-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2020-01-02"]);
  run(["add", "--title", "other", "--tags", "home", "--due", "2020-01-01"]);
  run(["add", "--title", "completed", "--tags", "work", "--due", "2020-01-01"]);
  run(["add", "--title", "undated"]);
  run(["done", "4"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--tag", " WORK ", "--status", "open", "--overdue", "2020-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2020-01-02"]).map((t: any) => t.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
});

test("stats uses today's local date and default storage works", () => {
  const timezone = "Pacific/Kiritimati";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  run(["add", "--title", "past", "--due", "2000-01-01"], true, null);
  run(["add", "--title", "today", "--due", today], true, null);
  run(["add", "--title", "done", "--due", "2000-01-01"], true, null);
  run(["done", "3"], true, null);
  expect(run(["stats"], true, null, timezone)).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});

test("invalid inputs and missing tasks fail without changing storage", () => {
  run(["add", "--title", "keep"]);
  const before = readFileSync(file, "utf8");
  const cases = [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "a", "--title", "b"], ["add", "--unknown", "x"],
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "extra"],
    ["stats", "--title", "x"], ["done", "1", "2"], ["done", "1x"], ["delete", "0"],
    ["done", "9007199254740992"], ["done", "99"], ["delete", "99"]];
  for (const date of ["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-01", "nonsense"]) {
    cases.push(["add", "--title", "bad", "--due", date], ["list", "--overdue", date]);
  }
  for (const args of cases) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and invalid database structures are never replaced", () => {
  const task = run(["add", "--title", "valid"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] })];
  for (const patch of [{ id: -1 }, { title: "" }, { status: "other" }, { tags: ["UPPER"] },
    { tags: ["x", "x"] }, { due: "2023-02-29" }, { createdAt: "bad" }, { status: "done" }, { completedAt: task.createdAt }]) {
    invalid.push(JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...patch }] }));
  }
  invalid.push(JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }));
  for (const contents of invalid) {
    writeFileSync(file, contents);
    for (const args of [["list"], ["stats"], ["add", "--title", "new"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  }
});

test("storage errors produce the JSON failure contract", () => {
  run(["add", "--title", "no parent"], false, join(directory, "missing", "tasks.json"));
  run(["list"], false, directory);
  expect(readdirSync(directory)).toEqual([]);
});
