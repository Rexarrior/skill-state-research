import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(join(resolve(import.meta.dir), ".run-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], success = true, customFile: string | undefined = file, tz?: string) {
  const env = { ...process.env, TASKBOARD_FILE: customFile, ...(tz ? { TZ: tz } : {}) };
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  expect(result.exitCode === 0).toBe(success);
  if (success) expect(result.stderr.toString()).toBe("");
  else {
    expect(result.stderr.toString().length).toBeGreaterThan(0);
    expect(typeof value.error).toBe("string");
  }
  return value;
}

test("persistent lifecycle, normalized tags, stable IDs and idempotent completion", () => {
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", "  Ship release  ", "--tags", " Work,urgent,work,, URGENT ", "--due", "2028-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "Ship release", status: "open", tags: ["work", "urgent"], due: "2028-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const completed = run(["done", "1"]);
  expect(completed.status).toBe("done");
  expect(new Date(completed.completedAt).toISOString()).toBe(completed.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(completed);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(completed);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("list combines filters, sorts IDs and excludes done tasks and boundary dates from overdue", () => {
  run(["add", "--title", "Before", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  run(["add", "--title", "Other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "Done", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "4"]);
  run(["add", "--title", "No date", "--tags", "work"]);
  const database = JSON.parse(readFileSync(file, "utf8"));
  database.tasks.reverse();
  writeFileSync(file, JSON.stringify(database));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1, 3]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([4]);
});

test("stats uses local date and only counts open overdue tasks", () => {
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  for (const tz of ["Pacific/Kiritimati", "Pacific/Honolulu"]) {
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    writeFileSync(file, JSON.stringify({ version: 1, nextId: 1, tasks: [] }));
    run(["add", "--title", "Old", "--due", "2000-01-01"]);
    run(["add", "--title", "Today", "--due", local]);
    run(["add", "--title", "Future", "--due", "9999-12-31"]);
    run(["add", "--title", "Completed", "--due", "2000-01-01"]);
    run(["done", "4"]);
    expect(run(["stats"], true, file, tz)).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
  }
});

test("invalid arguments and missing tasks fail without modifying storage", () => {
  run(["add", "--title", "Keep"]);
  const bytes = readFileSync(file, "utf8");
  for (const args of [[], ["unknown"], ["stats", "--x"], ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "x", "--unknown", "y"], ["add", "--title", "x", "--title", "y"], ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "24-01-01"].map(d => ["add", "--title", "Bad", "--due", d]), ["list", "--status", "invalid"], ["list", "--tag", " "], ["list", "--overdue", "2023-02-29"], ["list", "--unknown", "x"], ["done", "99"], ["delete", "99"], ["done", "0"], ["done", "1.5"], ["delete", "1", "extra"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});

test("malformed JSON and invalid database structures are preserved", () => {
  run(["add", "--title", "Seed"]);
  const valid = JSON.parse(readFileSync(file, "utf8"));
  const task = valid.tasks[0];
  for (const content of ["{", "null", "[]", "{}", JSON.stringify({ ...valid, nextId: 1 }), JSON.stringify({ ...valid, tasks: [task, task] }), ...[{ tags: ["UPPER"] }, { due: "2025-02-29" }, { status: "done" }, { createdAt: "invalid" }, { title: " " }].map(change => JSON.stringify({ ...valid, tasks: [{ ...task, ...change }] }))]) {
    writeFileSync(file, content);
    for (const args of [["list"], ["stats"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  }
});

test("default storage and write errors", () => {
  expect(run(["add", "--title", "Default"], true, undefined).id).toBe(1);
  // Pass an environment without TASKBOARD_FILE to exercise the default path.
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  const result = Bun.spawnSync([process.execPath, "run", cli, "add", "--title", "Local"], { cwd: directory, env });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).title).toBe("Local");
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks).toHaveLength(1);
  run(["add", "--title", "Cannot write"], false, join(directory, "missing", "tasks.json"));
  run(["list"], false, directory);
});
