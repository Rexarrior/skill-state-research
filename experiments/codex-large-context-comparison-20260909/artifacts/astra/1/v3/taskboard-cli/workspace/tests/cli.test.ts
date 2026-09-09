import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve("src/cli.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(defaultFile = false) {
  const dir = mkdtempSync(resolve(".test-taskboard-"));
  dirs.push(dir);
  const file = join(dir, defaultFile ? ".taskboard.json" : "data.json");
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (!defaultFile) env.TASKBOARD_FILE = file;
  function run(args: string[], success = true) {
    const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    const stdout = result.stdout.toString();
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const value = JSON.parse(stdout);
    expect(result.exitCode === 0).toBe(success);
    if (success) expect(result.stderr.toString()).toBe("");
    else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
    return value;
  }
  return { dir, file, run };
}

test("persists lifecycle across processes and never reuses IDs", () => {
  const { run, file, dir } = setup();
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work, HOME,,home ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["data.json"]);
});

test("filters use AND, strict overdue and ascending IDs", () => {
  const { run, file } = setup();
  run(["add", "--title", "Old", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "Undated", "--tags", "work"]);
  run(["add", "--title", "Completed", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "5"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
});

test("stats uses local today and excludes completed and undated tasks", () => {
  const { run } = setup(true);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "Past", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Undated"]);
  run(["add", "--title", "Done", "--due", "2000-01-01"]);
  run(["done", "4"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid commands and values fail without changing stored bytes", () => {
  const { run, file } = setup();
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  for (const args of [[], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"],
    ["add", "--title", "x", "--due", "2024-2-01"], ["add", "--title", "x", "--title", "y"],
    ["list", "--bogus", "x"], ["list", "--status", "other"], ["list", "--tag", " "],
    ["list", "--overdue", "2024-13-01"], ["stats", "extra"], ["done", "999"], ["delete", "999"],
    ["done", "1.0"], ["delete", "-1"], ["done", "1", "extra"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("corrupt databases fail without replacement", () => {
  const { run, file } = setup();
  const task = run(["add", "--title", "Keep"]);
  const databases = ["{", "null", "[]", '{}', JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2023-02-29" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, status: "done" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, tags: ["Work"] }] })];
  for (const content of databases) {
    writeFileSync(file, content);
    for (const args of [["list"], ["stats"], ["add", "--title", "No"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  }
});

test("missing storage parent fails without creating files", () => {
  const { dir } = setup();
  const result = Bun.spawnSync([process.execPath, "run", cli, "add", "--title", "No"], {
    cwd: dir, env: { ...process.env, TASKBOARD_FILE: join(dir, "missing", "data.json") }
  });
  expect(result.exitCode).not.toBe(0);
  expect(typeof JSON.parse(result.stdout.toString()).error).toBe("string");
  expect(readdirSync(dir)).toEqual([]);
});
