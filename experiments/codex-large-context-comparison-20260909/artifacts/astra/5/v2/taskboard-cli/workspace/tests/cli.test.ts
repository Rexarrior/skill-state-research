import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup(defaultFile = false) {
  const directory = mkdtempSync(resolve(import.meta.dir, ".taskboard-test-"));
  directories.push(directory);
  const file = join(directory, defaultFile ? ".taskboard.json" : "tasks.json");
  function run(args: string[], success = true) {
    const env = { ...process.env };
    delete env.TASKBOARD_FILE;
    if (!defaultFile) env.TASKBOARD_FILE = file;
    const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
    const stdout = result.stdout.toString();
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const value = JSON.parse(stdout);
    expect(result.exitCode === 0).toBe(success);
    if (success) expect(result.stderr.toString()).toBe("");
    else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
    return value;
  }
  return { directory, file, run };
}

test("separate processes persist tasks, normalize tags, complete idempotently, and never reuse IDs", () => {
  const { run, file, directory } = setup();
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  Ship it  ", "--tags", " Work,work, URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  const second = run(["add", "--title", "Second"]);
  expect(second.id).toBe(2);
  expect(second.tags).toEqual([]);
  expect(second.due).toBeUndefined();
  expect(run(["list"])).toEqual([first, second]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["delete", "2"])).toEqual(second);
  expect(run(["add", "--title", "Third"]).id).toBe(3);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("filters combine, overdue is strict and excludes done, and list sorts IDs", () => {
  const { run, file } = setup();
  run(["add", "--title", "old", "--tags", "work", "--due", "2020-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2020-01-02"]);
  run(["add", "--title", "finished", "--tags", "work", "--due", "2019-12-31"]);
  run(["done", "3"]);
  run(["add", "--title", "no due", "--tags", "home"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((task: any) => task.id)).toEqual([1, 2, 3, 4]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2020-01-02"]).map((task: any) => task.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((task: any) => task.id)).toEqual([3]);
});

test("stats uses local date and excludes today's due dates and completed tasks", () => {
  const { run } = setup(true);
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "past", "--due", "0001-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "future", "--due", "9999-12-31"]);
  run(["add", "--title", "done", "--due", "0001-01-01"]);
  run(["done", "4"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid commands and arguments fail without modifying storage", () => {
  const { run, file } = setup();
  run(["add", "--title", "keep"]);
  const before = readFileSync(file, "utf8");
  const cases = [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--unknown", "y"], ["add", "--title", "x", "--title", "y"],
    ["list", "--status", "bad"], ["list", "extra"], ["list", "--tag"], ["stats", "--oops"],
    ["done"], ["done", "0"], ["done", "1.2"], ["done", "1", "extra"], ["done", "999"],
    ["delete", "999"], ["delete", "-1"], ["delete", "9007199254740992"]];
  for (const date of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-10", "2024-13-01", "2024-01-00", "0000-01-01", "2024-1-01", "nonsense"]) {
    cases.push(["add", "--title", "x", "--due", date], ["list", "--overdue", date]);
  }
  for (const args of cases) { run(args, false); expect(readFileSync(file, "utf8")).toBe(before); }
});

test("malformed JSON and structurally invalid databases are preserved", () => {
  const { run, file } = setup();
  const task = run(["add", "--title", "keep"]);
  const invalid = ["", "{", "null", "[]", "{}", JSON.stringify({ version: 2, nextId: 2, tasks: [task] })];
  for (const patch of [{ id: 0 }, { title: "" }, { tags: ["UPPER"] }, { tags: ["x", "x"] }, { due: "2023-02-29" }, { status: "bad" }, { status: "done" }, { createdAt: "yesterday" }]) {
    invalid.push(JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...patch }] }));
  }
  invalid.push(JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }));
  for (const text of invalid) {
    writeFileSync(file, text);
    run(["add", "--title", "must not replace"], false);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});
