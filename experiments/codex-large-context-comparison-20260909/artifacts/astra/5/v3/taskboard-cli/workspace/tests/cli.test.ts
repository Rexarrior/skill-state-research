import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;
beforeEach(async () => {
  await mkdir(resolve(import.meta.dir, "../.test-tmp"), { recursive: true });
  directory = await mkdtemp(resolve(import.meta.dir, "../.test-tmp/case-"));
  file = join(directory, "tasks.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function run(args: string[], success = true, defaultFile = false) {
  const env = { ...process.env };
  if (defaultFile) delete env.TASKBOARD_FILE;
  else env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(stdout);
  if (success) { expect(result.exitCode).toBe(0); expect(result.stderr.toString()).toBe(""); }
  else { expect(result.exitCode).not.toBe(0); expect(result.stderr.toString().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
  return value;
}
test("persists across processes, normalizes tags, completes idempotently and never reuses IDs", async () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work,HOME,, home ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = await readFile(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(await readdir(directory)).toEqual(["tasks.json"]);
});
test("filters combine, overdue is strict and excludes done, and IDs sort numerically", async () => {
  run(["add", "--title", "Old", "--tags", "work", "--due", "2020-01-01"]);
  run(["add", "--title", "Equal", "--tags", "work", "--due", "2020-01-02"]);
  run(["add", "--title", "Other", "--tags", "home", "--due", "2020-01-01"]);
  run(["add", "--title", "Done", "--tags", "work", "--due", "2020-01-01"]);
  run(["done", "4"]);
  run(["add", "--title", "Undated", "--tags", "work"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2020-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
  expect(run(["list", "--overdue", "2020-01-02"]).map((t: any) => t.id)).toEqual([1, 3]);
  const db = JSON.parse(await readFile(file, "utf8"));
  db.tasks.reverse();
  await writeFile(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});
test("stats uses today's local date", () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "Past", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Undated"]);
  run(["add", "--title", "Done", "--due", "2000-01-01"]);
  run(["done", "4"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});
test("invalid commands and inputs preserve existing bytes", async () => {
  run(["add", "--title", "Keep"]);
  const original = await readFile(file, "utf8");
  const invalid = [[], ["unknown"], ["list", "--wat", "x"], ["add"], ["add", "--title", " "],
    ["add", "--title"], ["add", "--title", "X", "--title", "Y"], ["list", "extra"],
    ["list", "--status", "bad"], ["list", "--tag", " "], ["done", "999"], ["delete", "999"],
    ["done", "1.0"], ["delete", "-1"], ["done", "1", "--bad"], ["stats", "--bad"],
    ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-1-1", "bad"].flatMap(date => [
      ["add", "--title", "X", "--due", date], ["list", "--overdue", date]])];
  for (const args of invalid) { run(args, false); expect(await readFile(file, "utf8")).toBe(original); }
});
test("malformed databases fail on reads and writes without replacement", async () => {
  const validTask = { id: 1, title: "X", status: "open", tags: [], createdAt: "2024-01-01T00:00:00.000Z" };
  const malformed = ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [validTask] }),
    ...[{ status: "bad" }, { tags: ["X"] }, { due: "2023-02-29" }, { createdAt: "bad" }, { status: "done" }]
      .map(change => JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...validTask, ...change }] }))];
  for (const bytes of malformed) {
    await writeFile(file, bytes);
    run(["list"], false); run(["add", "--title", "No"], false);
    expect(await readFile(file, "utf8")).toBe(bytes);
  }
});
test("default storage and missing database stats", async () => {
  expect(run(["stats"], true, true)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(["add", "--title", "Default"], true, true);
  expect(JSON.parse(await readFile(join(directory, ".taskboard.json"), "utf8")).tasks[0].title).toBe("Default");
  expect(run(["list"])).toEqual([]);
});
test("unreadable database target fails without creating temporary files", async () => {
  await mkdir(file);
  run(["add", "--title", "No"], false);
  expect(await readdir(directory)).toEqual(["tasks.json"]);
});
