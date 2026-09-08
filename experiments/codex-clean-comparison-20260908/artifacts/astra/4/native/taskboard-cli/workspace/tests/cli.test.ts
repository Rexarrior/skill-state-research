import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const temporaryRoot = resolve(import.meta.dir, "../.test-tmp");
let directory: string;
let file: string;

beforeEach(() => {
  mkdirSync(temporaryRoot, { recursive: true });
  directory = mkdtempSync(join(temporaryRoot, "run-"));
  file = join(directory, "tasks.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], success = true, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  // Parsing the complete output also rejects extra JSON values or log chatter.
  const value = JSON.parse(stdout);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  if (success) {
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
  } else {
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString().trim()).not.toBe("");
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("persists tasks across processes with normalized tags and stable IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First task  ", "--tags", " Work,work,HOME, ,home", "--due", "2024-02-29"]);
  expect(first).toEqual({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2024-02-29", createdAt: expect.any(String) });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["add", "--title", "Second"])).toMatchObject({ id: 2, tags: [] });
  expect(run(["delete", "2"])).toMatchObject({ id: 2 });
  expect(run(["add", "--title", "Third"])).toMatchObject({ id: 3 });
  expect(run(["list"]).map((task: any) => task.id)).toEqual([1, 3]);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("completion is idempotent, including the stored timestamp", () => {
  run(["add", "--title", "Finish"]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["list", "--status", "done"])).toEqual([done]);
});

test("filters combine with AND, overdue is strict and excludes done and undated tasks", () => {
  run(["add", "--title", "Earlier", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Other tag", "--tags", "home", "--due", "2023-12-31"]);
  run(["add", "--title", "Completed", "--tags", "work", "--due", "2023-12-31"]);
  run(["done", "4"]);
  run(["add", "--title", "Undated", "--tags", "work"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((task: any) => task.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((task: any) => task.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((task: any) => task.id)).toEqual([1, 2, 3, 4, 5]);
});

test("stats uses the local calendar date in different time zones", () => {
  for (const timezone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    rmSync(file, { force: true });
    expect(run(["stats"], true, { TZ: timezone })).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
    run(["add", "--title", "Today", "--due", today]);
    run(["add", "--title", "Old", "--due", "2000-01-01"]);
    run(["add", "--title", "Done", "--due", "2000-01-01"]);
    run(["done", "3"]);
    run(["add", "--title", "Undated"]);
    expect(run(["stats"], true, { TZ: timezone })).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
  }
});

test("invalid commands, values and missing tasks leave the database untouched", () => {
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  const invalid = [[], ["unknown"], ["add"], ["add", "--title", "  "],
    ["add", "--title"], ["add", "--title", "X", "--bogus", "x"],
    ["add", "--title", "X", "--title", "Y"], ["list", "extra"],
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "--tag"],
    ["stats", "--all"], ["done"], ["delete", "0"], ["done", "1.5"],
    ["done", "9007199254740992"], ["done", "1", "extra"], ["done", "99"], ["delete", "99"]];
  for (const date of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-10", "2024-13-01", "2024-01-00", "0000-01-01", "2024-1-01", "tomorrow"]) {
    invalid.push(["add", "--title", "X", "--due", date], ["list", "--overdue", date]);
  }
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and invalid database records are never replaced", () => {
  const task = run(["add", "--title", "Keep"]);
  const malformed = ["", "{", "null", "[]", "{}", JSON.stringify({ version: 2, nextId: 2, tasks: [task] })];
  for (const changes of [{ id: 0 }, { status: "invalid" }, { tags: ["UPPER"] }, { tags: ["x", "x"] }, { due: "2024-02-30" }, { createdAt: "bad" }, { status: "done" }, { completedAt: task.createdAt }]) {
    malformed.push(JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...changes }] }));
  }
  malformed.push(JSON.stringify({ version: 1, nextId: 1, tasks: [task] }), JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }));
  for (const content of malformed) {
    writeFileSync(file, content);
    for (const args of [["list"], ["stats"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  }
});

test("default path works and filesystem failures emit one JSON error", () => {
  run(["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  expect(run(["list"])).toEqual([]);
  run(["add", "--title", "Missing parent"], false, { TASKBOARD_FILE: join(directory, "missing", "tasks.json") });
  run(["list"], false, { TASKBOARD_FILE: directory });
  run(["list"], false, { TASKBOARD_FILE: "" });
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});
