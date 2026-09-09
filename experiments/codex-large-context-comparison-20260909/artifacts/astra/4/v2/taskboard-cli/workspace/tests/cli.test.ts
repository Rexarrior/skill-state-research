import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const cli = resolve("src/cli.ts");
let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(resolve(".taskboard-tests-"));
  file = join(directory, "board.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function run(args: string[], ok = true, customFile = true) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (customFile) env.TASKBOARD_FILE = file;
  const proc = Bun.spawn([process.execPath, "run", cli, ...args], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code === 0).toBe(ok);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (ok) expect(stderr).toBe("");
  else { expect(stderr.length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
  return value;
}

test("persists across processes, normalizes tasks, completion is idempotent, IDs survive deletion", async () => {
  const first = await run(["add", "--title", "  First  ", "--tags", " Work,work, HOME, ,home", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(await run(["list"])).toEqual([first]);
  const done = await run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = await readFile(file, "utf8");
  expect(await run(["done", "1"])).toEqual(done);
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(await run(["delete", "1"])).toEqual(done);
  expect(await run(["list"])).toEqual([]);
  expect((await run(["add", "--title", "Second"])).id).toBe(2);
  expect(await readdir(directory)).toEqual(["board.json"]);
});

test("filters combine, ordering is ascending, overdue is strict and excludes done", async () => {
  await run(["add", "--title", "Early", "--tags", "work", "--due", "2024-01-01"]);
  await run(["add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02"]);
  await run(["add", "--title", "Done", "--tags", "work", "--due", "2023-01-01"]);
  await run(["done", "3"]);
  await run(["add", "--title", "No date", "--tags", "home"]);
  const db = JSON.parse(await readFile(file, "utf8"));
  db.tasks.reverse();
  await writeFile(file, JSON.stringify(db));
  expect((await run(["list"])).map((t: any) => t.id)).toEqual([1, 2, 3, 4]);
  expect((await run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-01-02"])).map((t: any) => t.id)).toEqual([1]);
  expect(await run(["list", "--status", "done", "--overdue", "2024-01-02"])).toEqual([]);
  expect((await run(["list", "--status", "done"])).map((t: any) => t.id)).toEqual([3]);
});

test("stats uses local today with strict boundary", async () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await run(["add", "--title", "Past", "--due", "2000-01-01"]);
  await run(["add", "--title", "Today", "--due", date]);
  await run(["add", "--title", "Completed", "--due", "2000-01-01"]);
  await run(["done", "3"]);
  expect(await run(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
});

test("invalid commands preserve data and emit exactly one JSON value", async () => {
  await run(["add", "--title", "Keep"]);
  const original = await readFile(file, "utf8");
  const cases = [[], ["unknown"], ["add"], ["add", "--title", "  "], ["add", "--title"],
    ["add", "--title", "X", "--due", "2023-02-29"], ["add", "--title", "X", "--due", "2024-04-31"],
    ["add", "--title", "X", "--due", "2024-13-01"], ["add", "--title", "X", "--due", "2024-1-01"],
    ["add", "--title", "X", "--wat", "x"], ["add", "--title", "X", "--title", "Y"],
    ["list", "--status", "pending"], ["list", "--tag", " "], ["list", "--overdue", "no"],
    ["list", "--unknown"], ["stats", "--status", "open"], ["done"], ["done", "0"], ["done", "1.5"],
    ["done", "1", "2"], ["done", "999"], ["delete", "999"], ["delete", "9007199254740993"]];
  for (const args of cases) {
    await run(args, false);
    expect(await readFile(file, "utf8")).toBe(original);
  }
});

test("malformed databases are rejected without modification", async () => {
  const task = await run(["add", "--title", "Valid"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 2, nextId: 2, tasks: [task] }),
    ...[
      { ...task, id: 0 }, { ...task, title: "" }, { ...task, tags: ["Work"] },
      { ...task, tags: ["work", "work"] }, { ...task, due: "2023-02-29" },
      { ...task, createdAt: "yesterday" }, { ...task, status: "done" }, { ...task, completedAt: task.createdAt },
    ].map(t => JSON.stringify({ version: 1, nextId: 2, tasks: [t] })),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
    JSON.stringify({ version: 1, nextId: 1, tasks: [task] })];
  for (const content of invalid) {
    await writeFile(file, content);
    for (const args of [["list"], ["add", "--title", "Do not overwrite"], ["stats"], ["done", "1"], ["delete", "1"]]) {
      await run(args, false);
      expect(await readFile(file, "utf8")).toBe(content);
    }
  }
});

test("default storage and empty board", async () => {
  expect(await run(["list"], true, false)).toEqual([]);
  expect(await run(["stats"], true, false)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  expect(await readdir(directory)).toEqual([]);
  await run(["add", "--title", "Default"], true, false);
  expect(await readdir(directory)).toEqual([".taskboard.json"]);
  expect((await run(["list"], true, false))[0].title).toBe("Default");
  expect(await run(["list"])).toEqual([]);
});

test("write failures are reported as JSON", async () => {
  file = join(directory, "missing", "board.json");
  await run(["add", "--title", "Cannot save"], false);
  expect(await readdir(directory)).toEqual([]);
});
