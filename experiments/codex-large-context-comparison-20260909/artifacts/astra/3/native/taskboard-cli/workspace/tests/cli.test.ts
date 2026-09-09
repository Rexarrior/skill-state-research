import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src/cli.ts");
const scratch = join(root, ".test-tmp");
let dir: string;
let file: string;

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, "case-"));
  file = join(dir, "tasks.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], ok = true, defaultFile = false, extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.TASKBOARD_FILE;
  if (!defaultFile) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(result.exitCode === 0).toBe(ok);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) expect(stderr).toBe("");
  else {
    expect(stderr.trim().length).toBeGreaterThan(0);
    expect(value).toBeNull();
  }
  return value;
}

test("persists tasks across processes, normalizes tags, and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  expect(existsSync(file)).toBe(false);
  const task = run(["add", "--title", "  First task  ", "--tags", " Work,work,HOME,, home ", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(task.completedAt).toBeUndefined();
  expect(run(["list"])).toEqual([task]);
  expect(run(["delete", "1"])).toEqual(task);
  const next = run(["add", "--title", "Next"]);
  expect(next.id).toBe(2);
  expect(next.tags).toEqual([]);
  expect(next.due).toBeUndefined();
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
});

test("completion is idempotent and missing IDs preserve the file", () => {
  run(["add", "--title", "Finish"]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  run(["done", "2"], false);
  run(["delete", "2"], false);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("filters combine, overdue is strict and open-only, and list sorts IDs", () => {
  run(["add", "--title", "Earlier", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Completed", "--tags", "work", "--due", "2023-12-31"]);
  run(["add", "--title", "Home", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "No deadline"]);
  run(["done", "3"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1, 4]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});

test("stats uses today's local date and excludes completed tasks", () => {
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  const timezone = "Pacific/Honolulu";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  run(["add", "--title", "Past", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Future", "--due", "9999-12-31"]);
  run(["add", "--title", "Done", "--due", "2000-01-01"]);
  run(["done", "4"]);
  expect(run(["stats"], true, false, { TZ: timezone })).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("rejects invalid arguments without changing data", () => {
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  const invalid = [
    [], ["wat"], ["add"], ["add", "--title", "  "], ["add", "--title"],
    ["add", "--title", "A", "--title", "B"], ["add", "--title", "A", "--unknown", "B"],
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "--wat"],
    ["list", "extra"], ["stats", "--status", "open"], ["done"], ["delete", "1", "2"],
    ...["0", "-1", "1.1", "1e0", "9007199254740992", "x"].map(id => ["done", id]),
    ...["2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-01", "nope"].flatMap(date => [
      ["add", "--title", "Bad date", "--due", date], ["list", "--overdue", date],
    ]),
  ];
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and invalid database records are never overwritten", () => {
  const task = run(["add", "--title", "Valid"]);
  const bad = [
    "", "{", "null", "[]", "{}",
    ...[
      { nextId: 1, tasks: [task] },
      { nextId: 2, tasks: [task, task] },
      { nextId: 2, tasks: [{ ...task, status: "unknown" }] },
      { nextId: 2, tasks: [{ ...task, createdAt: "bad" }] },
      { nextId: 2, tasks: [{ ...task, tags: ["Work"] }] },
      { nextId: 2, tasks: [{ ...task, due: "2025-02-29" }] },
      { nextId: 2, tasks: [{ ...task, status: "done" }] },
    ].map(value => JSON.stringify(value)),
  ];
  for (const content of bad) {
    writeFileSync(file, content);
    run(["list"], false);
    run(["add", "--title", "Do not replace"], false);
    expect(readFileSync(file, "utf8")).toBe(content);
  }
});

test("default path works and storage failures produce one JSON value", () => {
  run(["add", "--title", "Default"], true, true);
  expect(existsSync(join(dir, ".taskboard.json"))).toBe(true);
  expect(run(["list"], true, true)).toHaveLength(1);
  file = join(dir, "missing-parent", "db.json");
  run(["add", "--title", "Cannot save"], false);
  file = dir;
  run(["list"], false);
});
