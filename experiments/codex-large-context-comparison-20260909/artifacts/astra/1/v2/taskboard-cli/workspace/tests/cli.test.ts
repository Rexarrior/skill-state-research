import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const root = mkdtempSync(resolve(".test-"));
const cli = resolve("src/cli.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function database() { return join(root, `db-${counter++}.json`); }
function run(file: string, args: string[], success = true, extraEnv = {}) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: root, env: { ...process.env, TASKBOARD_FILE: file, ...extraEnv },
  });
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

test("separate processes persist tasks, normalize tags, and never reuse IDs", () => {
  const file = database();
  expect(run(file, ["list"])).toEqual([]);
  const first = run(file, ["add", "--title", "  First  ", "--tags", " Work,work, URGENT,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", tags: ["work", "urgent"], due: "2024-02-29", status: "open" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  const second = run(file, ["add", "--title", "Second"]);
  expect(second.id).toBe(2);
  expect(second.tags).toEqual([]);
  expect(second.due).toBeUndefined();
  expect(run(file, ["list"])).toEqual([first, second]);
  expect(run(file, ["delete", "2"])).toEqual(second);
  expect(run(file, ["add", "--title", "Third"]).id).toBe(3);
  expect(run(file, ["list"]).map((t: any) => t.id)).toEqual([1, 3]);
});

test("AND filters, strict overdue boundary, and idempotent completion", () => {
  const file = database();
  run(file, ["add", "--title", "Earlier", "--tags", "work", "--due", "2024-01-01"]);
  run(file, ["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(file, ["add", "--title", "No date", "--tags", "home"]);
  expect(run(file, ["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  const done = run(file, ["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(file, ["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(file, ["list", "--status", "done"])).toEqual([done]);
  expect(run(file, ["list", "--status", "done", "--overdue", "2025-01-01"])).toEqual([]);
});

test("stats uses local today and counts only open overdue tasks", () => {
  const file = database();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  run(file, ["add", "--title", "Old", "--due", "2000-01-01"]);
  run(file, ["add", "--title", "Today", "--due", today]);
  run(file, ["add", "--title", "Completed", "--due", "2000-01-01"]);
  run(file, ["done", "3"]);
  expect(run(file, ["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
});

test("invalid commands and arguments preserve the database", () => {
  const file = database();
  run(file, ["add", "--title", "Keep"]);
  const bytes = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["list", "--wat", "x"], ["add"], ["add", "--title", " "],
    ["add", "--title"], ["add", "--title", "x", "--title", "y"], ["stats", "extra"],
    ["list", "--status", "invalid"], ["done", "0"], ["done", "1.5"], ["done", "999"],
    ["delete", "999"], ["delete", "1", "extra"], ["done", "9007199254740993"],
    ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-01", "nonsense"].flatMap(date => [
      ["add", "--title", "Bad", "--due", date], ["list", "--overdue", date],
    ])]) {
    run(file, args, false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});

test("malformed JSON and schemas fail without replacing data", () => {
  const file = database();
  run(file, ["add", "--title", "Seed"]);
  const good = JSON.parse(readFileSync(file, "utf8"));
  const task = good.tasks[0];
  const invalid = ["{broken", "null", "[]", "{}", JSON.stringify({ ...good, nextId: 1 }),
    ...[{ ...task, tags: ["UPPER"] }, { ...task, due: "2023-02-29" },
      { ...task, status: "done" }, { ...task, createdAt: "invalid" },
      { ...task, tags: ["a", "a"] }].map(t => JSON.stringify({ ...good, tasks: [t] })),
    JSON.stringify({ ...good, tasks: [task, task] })];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    for (const args of [["list"], ["stats"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"]]) {
      run(file, args, false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  }
});

test("default storage, sorted reads, and temporary file cleanup", () => {
  const file = join(root, ".taskboard.json");
  run(file, ["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(file, "utf8")).tasks[0].title).toBe("Default");
  run(file, ["add", "--title", "Second"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(file, ["list"]).map((t: any) => t.id)).toEqual([1, 2]);
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  run(join(root, "missing-parent", "db.json"), ["add", "--title", "Fail"], false);
});
