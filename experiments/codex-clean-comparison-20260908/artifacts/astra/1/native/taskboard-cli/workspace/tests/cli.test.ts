import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(resolve(import.meta.dir, "../.test-data-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function invoke(args: string[], success = true, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: file, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const result = JSON.parse(stdout);
  if (success) {
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
  } else {
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString().trim()).not.toBe("");
    expect(typeof result.error).toBe("string");
  }
  return result;
}

test("persists normalized tasks across processes and never reuses deleted IDs", () => {
  expect(invoke(["list"])).toEqual([]);
  const task = invoke(["add", "--title", "  First task  ", "--tags", " Work,work, URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(task.completedAt).toBeUndefined();
  expect(invoke(["list"])).toEqual([task]);
  expect(invoke(["delete", "1"])).toEqual(task);
  expect(invoke(["add", "--title", "Second"])).toMatchObject({ id: 2, tags: [] });
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("completion is idempotent, including timestamp and database bytes", () => {
  invoke(["add", "--title", "Finish"]);
  const done = invoke(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const saved = readFileSync(file, "utf8");
  expect(invoke(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(saved);
});

test("list sorts IDs and combines status, normalized tag and strict overdue filters", () => {
  invoke(["add", "--title", "Before", "--tags", "work", "--due", "2024-01-01"]);
  invoke(["add", "--title", "Equal", "--tags", "work", "--due", "2024-01-02"]);
  invoke(["add", "--title", "Done", "--tags", "work", "--due", "2023-01-01"]);
  invoke(["add", "--title", "Other", "--tags", "home", "--due", "2023-01-01"]);
  invoke(["add", "--title", "No due", "--tags", "work"]);
  invoke(["done", "3"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(invoke(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(invoke(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(invoke(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect(invoke(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
});

test("stats counts only open tasks due before the local date", () => {
  expect(invoke(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  const zone = "Pacific/Honolulu";
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  invoke(["add", "--title", "Old", "--due", "2000-01-01"]);
  invoke(["add", "--title", "Today", "--due", local]);
  invoke(["add", "--title", "Finished", "--due", "2000-01-01"]);
  invoke(["done", "3"]);
  invoke(["add", "--title", "Undated"]);
  expect(invoke(["stats"], true, { TZ: zone })).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("default storage and relative environment override are resolved in the working directory", () => {
  invoke(["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  invoke(["add", "--title", "Custom"], true, { TASKBOARD_FILE: "custom.json" });
  expect(invoke(["list"], true, { TASKBOARD_FILE: "custom.json" })[0].title).toBe("Custom");
});

test("invalid input and missing tasks fail without changing the database", () => {
  invoke(["add", "--title", "Keep"]);
  const saved = readFileSync(file, "utf8");
  const invalid = [
    [], ["unknown"], ["toString"], ["add"], ["add", "--title", "  "],
    ["add", "--title"], ["add", "--title", "ok", "--bogus", "x"],
    ["add", "--title", "ok", "--title", "duplicate"],
    ["list", "--status", "pending"], ["list", "--tag", " "],
    ["list", "--overdue", "2023-02-29"], ["list", "extra"],
    ["stats", "--title", "x"], ["done"], ["done", "0"], ["done", "1.5"],
    ["done", "9007199254740992"], ["done", "1", "extra"], ["done", "99"], ["delete", "99"],
    ...["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "0000-01-01", "2024-1-01", "junk"].map(date => ["add", "--title", "bad", "--due", date]),
  ];
  for (const args of invalid) {
    invoke(args, false);
    expect(readFileSync(file, "utf8")).toBe(saved);
  }
});

test("malformed JSON and invalid database schemas are never replaced", () => {
  const validTask = { id: 1, title: "Saved", tags: [], status: "open", createdAt: "2024-01-01T00:00:00.000Z" };
  const invalidTasks = [
    { ...validTask, due: "2024-02-30" }, { ...validTask, tags: ["Work"] },
    { ...validTask, tags: ["work", "work"] }, { ...validTask, status: "done" },
    { ...validTask, completedAt: "2024-01-01T00:00:00.000Z" }, { ...validTask, id: -1 },
    { ...validTask, createdAt: "bad" }, { ...validTask, title: " " }, null,
  ];
  const malformed = ["", "{broken", "null", "[]", "{}", JSON.stringify({ version: 2, nextId: 1, tasks: [] }),
    JSON.stringify({ version: 1, nextId: 1, tasks: [validTask] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [validTask, validTask] }),
    ...invalidTasks.map(task => JSON.stringify({ version: 1, nextId: 2, tasks: [task] }))];
  for (const contents of malformed) {
    writeFileSync(file, contents);
    invoke(["list"], false);
    invoke(["add", "--title", "Must not overwrite"], false);
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("storage failures report JSON errors", () => {
  invoke(["add", "--title", "Missing parent"], false, { TASKBOARD_FILE: join(directory, "missing", "db.json") });
  invoke(["list"], false, { TASKBOARD_FILE: directory });
  expect(readdirSync(directory)).toEqual([]);
});
