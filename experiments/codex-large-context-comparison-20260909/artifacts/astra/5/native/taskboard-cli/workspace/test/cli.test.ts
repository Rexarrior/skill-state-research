import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(process.cwd(), ".test-taskboard-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], success = true, extraEnv: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file, ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  // Parsing the whole stream rejects extra JSON values or non-JSON output.
  const value = JSON.parse(stdout);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  if (success) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString().trim().length).toBeGreaterThan(0);
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("persists tasks across processes, normalizes tags, and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work, HOME,,home ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  expect(run(["delete", "1"])).toEqual(first);
  const second = run(["add", "--title", "Second"]);
  expect(second.id).toBe(2);
  expect(second.tags).toEqual([]);
  expect(second.due).toBeUndefined();
  expect(run(["list"])).toEqual([second]);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("done is idempotent and persists its timestamp", () => {
  run(["add", "--title", "Task"]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["list", "--status", "done"])).toEqual([done]);
});

test("filters combine with AND and overdue is strict and excludes done tasks", () => {
  run(["add", "--title", "Before", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Equal", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Other tag", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "Done", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "4"]);
  run(["add", "--title", "No due", "--tags", "work"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});

test("stats counts overdue relative to local today", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "Past", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Future", "--due", "9999-12-31"]);
  run(["add", "--title", "Done", "--due", "2000-01-01"]);
  run(["done", "4"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid commands and arguments never modify the database", () => {
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  const invalid = [
    [], ["unknown"], ["add"], ["add", "--title", "  "],
    ["add", "--title"], ["add", "--title", "x", "--unknown", "x"],
    ["add", "--title", "x", "--title", "y"],
    ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-01", "nope", ""].map(date => ["add", "--title", "x", "--due", date]),
    ["list", "--status", "closed"], ["list", "--tag", " "], ["list", "--overdue", "2023-02-29"],
    ["list", "--wat", "x"], ["stats", "--wat"], ["done"], ["done", "0"],
    ["done", "1.0"], ["done", "9007199254740992"], ["done", "1", "2"],
    ["done", "999"], ["delete", "999"], ["delete", "-1"],
  ];
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and invalid database structures are preserved", () => {
  const task = run(["add", "--title", "Keep"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ nextId: 1, tasks: [task] }),
    JSON.stringify({ nextId: 2, tasks: [task, task] }),
    ...[{ status: "bad" }, { due: "2023-02-29" }, { tags: ["WORK"] }, { tags: ["a", "a"] }, { status: "done" }, { createdAt: "yesterday" }, { id: -1 }].map(change => JSON.stringify({ nextId: 2, tasks: [{ ...task, ...change }] })),
  ];
  for (const contents of invalid) {
    writeFileSync(file, contents);
    run(["list"], false);
    run(["add", "--title", "Do not replace"], false);
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("default storage uses the working directory", () => {
  run(["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  expect(run(["list"], true, { TASKBOARD_FILE: undefined })).toHaveLength(1);
});

test("storage errors fail with one JSON value", () => {
  run(["add", "--title", "Missing parent"], false, { TASKBOARD_FILE: join(directory, "missing", "tasks.json") });
  run(["list"], false, { TASKBOARD_FILE: directory });
  expect(readdirSync(directory)).toEqual([]);
});
