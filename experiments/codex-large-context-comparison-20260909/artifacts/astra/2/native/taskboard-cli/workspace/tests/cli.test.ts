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

function run(args: string[], ok = true, env: Record<string, string | undefined> = {}) {
  const processResult = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file, ...env },
  });
  const stdout = processResult.stdout.toString();
  const stderr = processResult.stderr.toString();
  expect(processResult.exitCode === 0).toBe(ok);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) expect(stderr).toBe("");
  else {
    expect(typeof value.error).toBe("string");
    expect(stderr).toContain(value.error);
  }
  return value;
}

test("persists tasks, normalizes fields, completes idempotently, and never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First task  ", "--tags", " Work,work, URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First task", tags: ["work", "urgent"], status: "open", due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(first.completedAt).toBeUndefined();
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"])).toMatchObject({ id: 2, tags: [] });
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("AND filters, strict overdue boundary, and ascending ID order", () => {
  run(["add", "--title", "late", "--tags", "work", "--due", "2025-01-01"]);
  run(["add", "--title", "boundary", "--tags", "work", "--due", "2025-01-02"]);
  run(["add", "--title", "complete", "--tags", "work", "--due", "2024-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "other", "--tags", "home", "--due", "2024-01-01"]);
  run(["add", "--title", "no date", "--tags", "work"]);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse();
  writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2025-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2025-01-02"])).toEqual([]);
  expect(run(["list", "--status", "done"]).map((t: any) => t.id)).toEqual([3]);
});

test("stats use local today and exclude done, undated, and today tasks from overdue", () => {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Honolulu", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  run(["add", "--title", "past", "--due", "0001-01-01"]);
  run(["add", "--title", "today", "--due", local]);
  run(["add", "--title", "future", "--due", "9999-12-31"]);
  run(["add", "--title", "undated"]);
  run(["add", "--title", "done", "--due", "2000-01-01"]);
  run(["done", "5"]);
  expect(run(["stats"], true, { TZ: "Pacific/Honolulu" })).toEqual({ total: 5, open: 4, done: 1, overdue: 1 });
});

test("invalid commands and inputs leave existing database untouched", () => {
  run(["add", "--title", "Keep me"]);
  const bytes = readFileSync(file, "utf8");
  const invalid = [
    [], ["wat"], ["add"], ["add", "--title", "   "], ["add", "--title"],
    ["add", "--title", "x", "--title", "y"], ["add", "--title", "x", "--unknown", "z"],
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "--tag"],
    ["list", "--unknown", "x"], ["stats", "--x"], ["done"], ["delete", "1", "2"],
    ["done", "1.0"], ["done", "-1"], ["done", "9007199254740993"], ["done", "99"], ["delete", "99"],
    ...["2023-02-29", "1900-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "0000-01-01", "2024-1-01", "not-a-date"].flatMap(date => [
      ["add", "--title", "x", "--due", date], ["list", "--overdue", date],
    ]),
  ];
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});

test("malformed JSON and invalid database structure fail without overwriting", () => {
  const task = run(["add", "--title", "original"]);
  const base = { version: 1, nextId: 2, tasks: [task] };
  const invalid = [
    "{broken", "", "null", "[]", "{}",
    JSON.stringify({ ...base, nextId: 1 }),
    JSON.stringify({ ...base, tasks: [task, task] }),
    ...[{ status: "other" }, { title: "" }, { due: "2025-02-29" }, { tags: ["Work"] },
      { tags: ["x", "x"] }, { createdAt: "bad" }, { status: "done" }, { completedAt: null },
      { id: -1 }].map(patch => JSON.stringify({ ...base, tasks: [{ ...task, ...patch }] })),
  ];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    for (const args of [["list"], ["add", "--title", "replacement"], ["done", "1"], ["delete", "1"], ["stats"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  }
});

test("default storage and filesystem failures follow the JSON output contract", () => {
  expect(run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("default");
  run(["add", "--title", "cannot save"], false, { TASKBOARD_FILE: join(directory, "missing", "tasks.json") });
  run(["list"], false, { TASKBOARD_FILE: directory });
});
