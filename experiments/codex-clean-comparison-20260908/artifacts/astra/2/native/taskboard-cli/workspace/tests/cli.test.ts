import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const entry = resolve("src/cli.ts");
let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(resolve(".taskboard-tests-"));
  file = join(directory, "tasks.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(args: string[], success = true, extraEnv: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: file, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (success) {
    expect(stderr).toBe("");
    expect(code).toBe(0);
  } else {
    expect(stderr.trim().length).toBeGreaterThan(0);
    expect(code).not.toBe(0);
    expect(value).toBeNull();
  }
  return value;
}

test("persistent lifecycle, normalized tags, stable IDs, and idempotent completion", async () => {
  expect(await run(["list"])).toEqual([]);
  const first = await run(["add", "--title", "  First  ", "--tags", " Work,work,URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(first.completedAt).toBeUndefined();
  const second = await run(["add", "--title", "Second"]);
  expect(second.id).toBe(2);
  expect(second.tags).toEqual([]);
  expect(second.due).toBeUndefined();
  expect(await run(["list"])).toEqual([first, second]);
  const completed = await run(["done", "1"]);
  expect(completed.status).toBe("done");
  expect(new Date(completed.completedAt).toISOString()).toBe(completed.completedAt);
  const before = await readFile(file, "utf8");
  expect(await run(["done", "1"])).toEqual(completed);
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await run(["delete", "2"])).toEqual(second);
  expect((await run(["add", "--title", "Third"])).id).toBe(3);
  expect((await readdir(directory)).sort()).toEqual(["tasks.json"]);
});

test("list filters combine, overdue excludes done and equal dates, results sort by ID", async () => {
  await run(["add", "--title", "Earlier", "--tags", "work", "--due", "2024-02-28"]);
  await run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-02-29"]);
  await run(["add", "--title", "Done", "--tags", "work", "--due", "2024-02-27"]);
  await run(["done", "3"]);
  await run(["add", "--title", "Other", "--tags", "home", "--due", "2024-02-27"]);
  await run(["add", "--title", "No due", "--tags", "work"]);
  const db = JSON.parse(await readFile(file, "utf8"));
  db.tasks.reverse();
  await writeFile(file, JSON.stringify(db));
  expect((await run(["list"])).map((task: any) => task.id)).toEqual([1, 2, 3, 4, 5]);
  expect((await run(["list", "--overdue", "2024-02-29"])).map((task: any) => task.id)).toEqual([1, 4]);
  expect((await run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-02-29"])).map((task: any) => task.id)).toEqual([1]);
  expect(await run(["list", "--status", "done", "--overdue", "2024-02-29"])).toEqual([]);
  expect((await run(["list", "--status", "done"])).map((task: any) => task.id)).toEqual([3]);
});

test("stats counts open overdue tasks using local calendar date", async () => {
  const timezone = "Pacific/Honolulu";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  expect(await run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  await run(["add", "--title", "Old", "--due", "2000-01-01"]);
  await run(["add", "--title", "Today", "--due", today]);
  await run(["add", "--title", "Done", "--due", "2000-01-01"]);
  await run(["done", "3"]);
  await run(["add", "--title", "Undated"]);
  expect(await run(["stats"], true, { TZ: timezone })).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});

test("invalid input and missing tasks never change stored bytes", async () => {
  await run(["add", "--title", "Keep"]);
  const original = await readFile(file, "utf8");
  const invalid = [
    [], ["unknown"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--bogus", "x"], ["add", "--title", "x", "--title", "y"],
    ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "24-01-01", "2024-1-01", ""].map(date => ["add", "--title", "x", "--due", date]),
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "--overdue", "2024-02-30"],
    ["list", "--unknown", "x"], ["list", "--tag"], ["stats", "extra"],
    ["done", "99"], ["delete", "99"], ["done"], ["delete", "0"], ["done", "1.0"],
    ["done", "-1"], ["done", "1", "extra"], ["delete", "9007199254740992"],
  ];
  for (const args of invalid) {
    await run(args, false);
    expect(await readFile(file, "utf8")).toBe(original);
  }
});

test("malformed JSON and schemas fail safely even on read commands", async () => {
  const task = await run(["add", "--title", "Keep"]);
  const corrupt = [
    "", "{", "null", "[]", "{}",
    JSON.stringify({ nextId: 1, tasks: [task] }),
    JSON.stringify({ nextId: 2, tasks: [task, task] }),
    ...[{ status: "invalid" }, { tags: ["Work"] }, { tags: ["a", "a"] }, { due: "2023-02-29" }, { createdAt: "bad" }, { status: "done" }, { completedAt: task.createdAt }, { id: -1 }].map(change => JSON.stringify({ nextId: 2, tasks: [{ ...task, ...change }] })),
  ];
  for (const contents of corrupt) {
    await writeFile(file, contents);
    for (const args of [["list"], ["stats"], ["add", "--title", "New"], ["done", "1"], ["delete", "1"]]) {
      await run(args, false);
      expect(await readFile(file, "utf8")).toBe(contents);
    }
  }
});

test("default storage, custom nested paths, and failed writes", async () => {
  await run(["add", "--title", "Default"], true, { TASKBOARD_FILE: undefined });
  expect(JSON.parse(await readFile(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  expect(await run(["list"])).toEqual([]);
  await run(["add", "--title", "Nested"], true, { TASKBOARD_FILE: "nested/board.json" });
  expect((await run(["list"], true, { TASKBOARD_FILE: "nested/board.json" }))[0].title).toBe("Nested");
  await writeFile(file, "blocking file");
  await run(["add", "--title", "Fail"], false, { TASKBOARD_FILE: join(file, "child.json") });
  expect(await readFile(file, "utf8")).toBe("blocking file");
  await run(["list"], false, { TASKBOARD_FILE: "" });
});
