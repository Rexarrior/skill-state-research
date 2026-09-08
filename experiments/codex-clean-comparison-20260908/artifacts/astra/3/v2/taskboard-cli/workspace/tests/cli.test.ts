import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve("src/cli.ts");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(resolve("tests/.run-"));
  directories.push(dir);
  const file = join(dir, "tasks.json");
  function run(args: string[], success = true, customFile: string | null = file, tz?: string) {
    const env = { ...process.env };
    delete env.TASKBOARD_FILE;
    if (customFile !== null) env.TASKBOARD_FILE = customFile;
    if (tz) env.TZ = tz;
    const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    const output = result.stdout.toString().trim();
    expect(output.split("\n")).toHaveLength(1);
    const value = JSON.parse(output);
    if (success) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString().trim().length).toBeGreaterThan(0);
      expect(value).toBeNull();
    }
    return value;
  }
  return { dir, file, run };
}

test("separate processes persist tasks, completion is idempotent, IDs are never reused", () => {
  const { run, file, dir } = fixture();
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", " Ship release ", "--tags", " Work,work, URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "Ship release", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["list"])).toEqual([]);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
});

test("filters combine with AND and overdue is strict and open-only; list sorts IDs", () => {
  const { run, file } = fixture();
  run(["add", "--title", "Old", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Done", "--tags", "work", "--due", "2023-12-31"]);
  run(["done", "3"]);
  run(["add", "--title", "Other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "Undated", "--tags", "work"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1, 4]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
});

test("stats uses local today with strict date boundary", () => {
  const { run } = fixture();
  const tz = "Pacific/Kiritimati";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  run(["add", "--title", "Old", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Completed", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "Undated"]);
  expect(run(["stats"], true, undefined, tz)).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid commands and arguments fail without modifying data", () => {
  const { run, file } = fixture();
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  const invalid = [[], ["wat"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"],
    ["add", "--title", "x", "--due", "2024-1-01"], ["add", "--title", "x", "--due", "2024-00-01"],
    ["add", "--title", "x", "--unknown", "x"], ["add", "--title", "x", "--title", "y"],
    ["list", "--status", "pending"], ["list", "--overdue", "no"], ["list", "--tag", " "],
    ["list", "extra"], ["stats", "--foo", "bar"], ["done"], ["done", "-1"], ["done", "1.0"],
    ["done", "9007199254740993"], ["done", "2"], ["delete", "2"], ["delete", "1", "--force"]];
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and schema are rejected without replacing data", () => {
  const { run, file } = fixture();
  const task = run(["add", "--title", "Keep"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2024-02-30" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, status: "done" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, tags: ["WORK"] }] })];
  for (const text of invalid) {
    writeFileSync(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "x"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
});

test("default path and relative environment path; filesystem failures emit JSON", () => {
  const { run, dir } = fixture();
  run(["add", "--title", "Default"], true, null);
  expect(JSON.parse(readFileSync(join(dir, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  run(["add", "--title", "Custom"], true, "relative.json");
  expect(run(["list"], true, "relative.json")[0].title).toBe("Custom");
  run(["add", "--title", "Failure"], false, "missing/tasks.json");
  mkdirSync(join(dir, "directory"));
  run(["list"], false, "directory");
  expect(readdirSync(dir).sort()).toEqual([".taskboard.json", "directory", "relative.json"]);
});
