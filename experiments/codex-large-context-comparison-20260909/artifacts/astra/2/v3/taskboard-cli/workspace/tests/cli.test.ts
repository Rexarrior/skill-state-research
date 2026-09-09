import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(resolve(".taskboard-test-")); file = join(dir, "db.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function run(args: string[], success = true, customFile = true) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (customFile) env.TASKBOARD_FILE = file;
  const processResult = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  const stdout = processResult.stdout.toString();
  const stderr = processResult.stderr.toString();
  expect(processResult.exitCode === 0).toBe(success);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const result = JSON.parse(stdout);
  if (success) expect(stderr).toBe("");
  else { expect(stderr.length).toBeGreaterThan(0); expect(typeof result.error).toBe("string"); }
  return result;
}

test("persists across processes, normalizes tags, completes idempotently, and never reuses IDs", async () => {
  expect(run(["list"])).toEqual([]);
  const a = run(["add", "--title", "  First  ", "--tags", " Work,work,HOME,, home ", "--due", "2024-02-29"]);
  expect(a).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
  expect(run(["list"])).toEqual([a]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = await readFile(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(await readdir(dir)).toEqual(["db.json"]);
});

test("filters use AND, strict overdue dates and ascending IDs", async () => {
  run(["add", "--title", "a", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "b", "--tags", "home", "--due", "2024-01-02"]);
  run(["add", "--title", "c", "--tags", "work", "--due", "2024-01-01"]);
  run(["add", "--title", "d"]);
  run(["done", "3"]);
  const db = JSON.parse(await readFile(file, "utf8"));
  db.tasks.reverse();
  await writeFile(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4]);
  expect(run(["list", "--overdue", "2024-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-03"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2024-01-03"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
});

test("stats use today's local date and exclude completed tasks", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  run(["add", "--title", "past", "--due", "2000-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "completed", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "undated"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid commands and missing tasks leave bytes unchanged", async () => {
  run(["add", "--title", "keep"]);
  const original = await readFile(file, "utf8");
  for (const args of [[], ["wat"], ["stats", "--foo"], ["add"], ["add", "--title", " "],
    ["add", "--title"], ["add", "--title", "a", "--title", "b"], ["add", "--foo", "bar"],
    ["add", "--title", "a", "--due", "2023-02-29"], ["add", "--title", "a", "--due", "2024-04-31"],
    ["add", "--title", "a", "--due", "2024-13-01"], ["list", "--overdue", "2024-2-01"],
    ["list", "--status", "other"], ["list", "--tag", " "], ["list", "--bad", "x"],
    ["done", "99"], ["delete", "99"], ["done", "1.0"], ["done", "-1"], ["delete", "1", "extra"]]) {
    run(args, false);
    expect(await readFile(file, "utf8")).toBe(original);
  }
});

test("malformed databases are rejected without replacement", async () => {
  const task = run(["add", "--title", "valid"]);
  const base = { version: 1, nextId: 2, tasks: [task] };
  const invalid = ["{oops", "null", "[]", "{}", JSON.stringify({ ...base, nextId: 1 }),
    JSON.stringify({ ...base, tasks: [task, task] }),
    ...[{ status: "oops" }, { tags: ["Work"] }, { tags: ["work", "work"] }, { due: "2024-02-30" },
      { createdAt: "yesterday" }, { status: "done" }, { completedAt: task.createdAt }, { id: 1.5 }]
      .map(patch => JSON.stringify({ ...base, tasks: [{ ...task, ...patch }] }))];
  for (const contents of invalid) {
    await writeFile(file, contents);
    for (const args of [["list"], ["add", "--title", "x"], ["stats"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  }
});

test("defaults to current-directory storage and reports write failure as JSON", async () => {
  expect(run(["stats"], true, false)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "default"], true, false);
  expect(JSON.parse(await readFile(join(dir, ".taskboard.json"), "utf8")).tasks[0].title).toBe("default");
  file = join(dir, "missing", "db.json");
  run(["add", "--title", "fail"], false);
});
