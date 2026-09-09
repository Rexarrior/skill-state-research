import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src/cli.ts");
let directory: string;
let file: string;
beforeEach(() => {
  mkdirSync(join(root, ".test-tmp"), { recursive: true });
  directory = mkdtempSync(join(root, ".test-tmp/case-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], ok = true, defaultPath = false) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (!defaultPath) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString().trim();
  expect(stdout.split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  } else {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString().trim().length).toBeGreaterThan(0);
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("separate processes persist tasks, normalize tags, complete idempotently, and never reuse IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  Ship  ", "--tags", " Work,work,URGENT,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "Ship", tags: ["work", "urgent"], due: "2024-02-29", status: "open" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine with AND and overdue excludes completed tasks and boundary dates", () => {
  run(["add", "--title", "early", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2024-02-01"]);
  run(["add", "--title", "done", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "undated"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-02-01"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-02-01"]).map((t: any) => t.id)).toEqual([1, 4]);
  expect(run(["list", "--status", "done", "--overdue", "2024-02-01"])).toEqual([]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});

test("stats uses local today and excludes done tasks from overdue", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "past", "--due", "2000-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "finished", "--due", "2000-01-01"]);
  run(["done", "3"]);
  expect(run(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
});

test("invalid commands and arguments fail without changing data", () => {
  run(["add", "--title", "keep"]);
  const bytes = readFileSync(file, "utf8");
  for (const args of [[], ["unknown"], ["add"], ["add", "--title", "  "], ["add", "--title"],
    ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"],
    ["add", "--title", "x", "--due", "2024-2-01"], ["add", "--title", "x", "--bogus", "x"],
    ["add", "--title", "x", "--title", "y"], ["list", "--status", "bad"], ["list", "--tag", " "],
    ["list", "--overdue", "invalid"], ["list", "--unknown", "x"], ["stats", "extra"],
    ["done", "999"], ["delete", "999"], ["done", "0"], ["done", "1.0"], ["done", "1", "extra"], ["delete"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});

test("malformed JSON and invalid database structures are never replaced", () => {
  for (const bytes of ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [{}] }),
    JSON.stringify({ version: 1, nextId: 0, tasks: [] })]) {
    writeFileSync(file, bytes);
    for (const args of [["list"], ["stats"], ["add", "--title", "x"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  }
});

test("default storage works and write failures return JSON errors", () => {
  run(["add", "--title", "default"], true, true);
  expect(run(["list"], true, true)).toHaveLength(1);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
  file = join(directory, "missing", "tasks.json");
  run(["add", "--title", "cannot save"], false);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});
