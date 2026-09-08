import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(resolve(import.meta.dir, ".."), ".taskboard-test-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], success = true, overrides: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file, ...overrides },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (success) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString().trim()).not.toBe("");
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("separate processes persist normalized tasks, completion and never-reused IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work, URGENT,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const content = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(content);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine, overdue is strict and excludes completed tasks, list sorts", () => {
  run(["add", "--title", "Before", "--tags", "x", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "x", "--due", "2024-02-01"]);
  run(["add", "--title", "Completed", "--tags", "x", "--due", "2023-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "Other tag", "--tags", "y", "--due", "2024-01-01"]);
  run(["add", "--title", "No due", "--tags", "x"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((task: any) => task.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " X ", "--overdue", "2024-02-01"]).map((task: any) => task.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2024-02-01"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((task: any) => task.id)).toEqual([3]);
});

test("stats uses local today and ignores undated, future and done tasks", () => {
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  const now = new Date();
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  for (const due of ["2000-01-01", local, "9999-12-31", "2000-01-01"]) run(["add", "--title", due, "--due", due]);
  run(["done", "4"]);
  run(["add", "--title", "Undated"]);
  expect(run(["stats"])).toEqual({ total: 5, open: 4, done: 1, overdue: 1 });
});

test("invalid commands and dates fail without changing data", () => {
  run(["add", "--title", "Keep"]);
  const original = readFileSync(file, "utf8");
  const cases = [
    [], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--bogus", "y"], ["add", "--title", "x", "--title", "y"],
    ["list", "--status", "invalid"], ["list", "--tag", " "], ["list", "extra"],
    ["stats", "--unknown"], ["done"], ["done", "999"], ["delete", "999"],
    ["delete", "1", "extra"], ["done", "1.0"], ["done", "-1"], ["done", "1e0"],
    ["done", "9007199254740992"],
  ];
  for (const date of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "2024-1-01", "tomorrow", ""]) {
    cases.push(["add", "--title", "x", "--due", date], ["list", "--overdue", date]);
  }
  for (const args of cases) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(original);
  }
});

test("malformed JSON and schema never get replaced", () => {
  const task = run(["add", "--title", "Keep"]);
  const documents = ["", "{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] })];
  for (const change of [{ id: -1 }, { status: "other" }, { tags: ["X"] }, { due: "2023-02-29" }, { createdAt: "no" }, { status: "done" }, { completedAt: task.createdAt }]) {
    documents.push(JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...change }] }));
  }
  documents.push(JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }));
  for (const document of documents) {
    writeFileSync(file, document);
    for (const args of [["list"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"], ["stats"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(document);
    }
  }
});

test("default storage and write errors produce the expected JSON contract", () => {
  run(["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  run(["add", "--title", "Failure"], false, { TASKBOARD_FILE: join(directory, "missing", "tasks.json") });
  run(["list"], false, { TASKBOARD_FILE: directory });
  run(["list"], false, { TASKBOARD_FILE: "" });
});
