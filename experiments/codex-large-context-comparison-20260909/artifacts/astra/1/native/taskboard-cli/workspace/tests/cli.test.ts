import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".taskboard-tests-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], success = true, defaultFile = false, timezone?: string) {
  const env = { ...process.env, TASKBOARD_FILE: file };
  if (defaultFile) delete env.TASKBOARD_FILE;
  if (timezone) env.TZ = timezone;
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
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("persists across processes, normalizes tags, completes idempotently, and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", "  Ship it  ", "--tags", " Work,work, URGENT,, ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "Ship it", tags: ["work", "urgent"], status: "open", due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const completed = run(["done", "1"]);
  expect(completed.status).toBe("done");
  expect(new Date(completed.completedAt).toISOString()).toBe(completed.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(completed);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(completed);
  expect(run(["list"])).toEqual([]);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine with AND and overdue is strict and only open", () => {
  run(["add", "--title", "early", "--tags", "work", "--due", "2024-02-28"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2024-02-29"]);
  run(["add", "--title", "done", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "undated", "--tags", "work"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-02-29"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2024-02-29"])).toEqual([]);
  expect(run(["list", "--overdue", "2024-02-29"]).map((t: any) => t.id)).toEqual([1, 4]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});

test("stats uses the local calendar date", () => {
  for (const timezone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    run(["add", "--title", "old", "--due", "0001-01-01"]);
    const boundary = run(["add", "--title", "today", "--due", today]);
    run(["add", "--title", "future", "--due", "9999-12-31"]);
    run(["add", "--title", "undated"]);
    const done = run(["add", "--title", "finished", "--due", "0001-01-01"]);
    run(["done", String(done.id)]);
    expect(run(["stats"], true, false, timezone)).toEqual({ total: 5, open: 4, done: 1, overdue: 1 });
    expect(boundary.due).toBe(today);
    rmSync(file);
  }
});

test("invalid commands and dates preserve existing bytes", () => {
  run(["add", "--title", "Keep"]);
  const original = readFileSync(file, "utf8");
  const invalid = [
    [], ["unknown"], ["add"], ["add", "--title", "  "], ["add", "--title"],
    ["add", "--title", "x", "--title", "y"], ["list", "--wat", "x"],
    ["list", "--status", "closed"], ["list", "--tag", " "], ["stats", "--all"],
    ["done"], ["done", "0"], ["done", "1x"], ["done", "1", "extra"],
    ["delete", "999"], ["done", "999"], ["delete", "9007199254740992"],
  ];
  for (const date of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "0000-01-01", "2024-2-01", "garbage"]) {
    invalid.push(["add", "--title", "x", "--due", date], ["list", "--overdue", date]);
  }
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(original);
  }
});

test("malformed JSON and invalid schemas fail without overwriting data", () => {
  const task = run(["add", "--title", "Keep"]);
  const valid = { version: 1, nextId: 2, tasks: [task] };
  const bad = ["", "{", "null", "[]", "{}", JSON.stringify({ ...valid, nextId: 1 }),
    JSON.stringify({ ...valid, tasks: [task, task] }),
    ...[{ id: -1 }, { title: " " }, { status: "invalid" }, { createdAt: "bad" },
      { tags: ["Work"] }, { tags: ["a", "a"] }, { due: "2025-02-29" },
      { status: "done" }, { completedAt: task.createdAt }]
      .map(change => JSON.stringify({ ...valid, tasks: [{ ...task, ...change }] })),
  ];
  for (const content of bad) {
    writeFileSync(file, content);
    for (const args of [["list"], ["add", "--title", "x"], ["done", "1"], ["delete", "1"], ["stats"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  }
});

test("default storage works and write failures produce JSON errors without residue", () => {
  expect(run(["stats"], true, true)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "default"], true, true);
  expect(run(["list"], true, true)[0].title).toBe("default");
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
  file = join(directory, "missing", "tasks.json");
  run(["add", "--title", "cannot save"], false);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});
