import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(resolve(import.meta.dir, ".taskboard-test-"));
  file = join(directory, "tasks.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], success = true, useDefault = false) {
  const env = { ...process.env };
  if (useDefault) delete env.TASKBOARD_FILE;
  else env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: directory, env });
  const output = result.stdout.toString().trim();
  expect(output.split("\n")).toHaveLength(1);
  const value = JSON.parse(output);
  expect(result.exitCode === 0).toBe(success);
  if (success) expect(result.stderr.toString()).toBe("");
  else {
    expect(typeof value.error).toBe("string");
    expect(result.stderr.toString().length).toBeGreaterThan(0);
  }
  return value;
}

test("persists between processes, normalizes tags, completes idempotently, never reuses IDs", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  Release  ", "--tags", " Work,work, URGENT, ,urgent", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "Release", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  expect(run(["list"])).toEqual([first]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Next"]).id).toBe(2);
  expect(readdirSync(directory)).toEqual(["tasks.json"]);
});

test("AND filters, strict overdue boundary, ascending IDs and stats", () => {
  run(["add", "--title", "Old", "--tags", "work", "--due", "2000-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2000-01-02"]);
  run(["add", "--title", "Completed", "--tags", "work", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "No due", "--tags", "home"]);
  expect(run(["list", "--tag", " WORK ", "--status", "open", "--overdue", "2000-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2000-01-02"])).toEqual([]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 2 });
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.tasks.reverse();
  writeFileSync(file, JSON.stringify(data));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4]);
});

test("stats uses local date and excludes today's due tasks", () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "Today", "--due", date]);
  expect(run(["stats"]).overdue).toBe(0);
});

test("bad arguments and missing tasks leave the database untouched", () => {
  run(["add", "--title", "Keep"]);
  const original = readFileSync(file, "utf8");
  const invalid = [
    [], ["unknown"], ["add"], ["add", "--title", "  "],
    ["add", "--title", "Bad", "--due", "2025-02-29"],
    ["add", "--title", "Bad", "--due", "2024-04-31"],
    ["add", "--title", "Bad", "--due", "2024-2-01"],
    ["add", "--title", "Bad", "--due", ""],
    ["add", "--title", "Bad", "--wat", "x"],
    ["add", "--title", "One", "--title", "Two"],
    ["list", "--tag"], ["list", "--tag", " "], ["list", "--status", "pending"],
    ["list", "--overdue", "2024-13-01"], ["list", "--unknown", "x"],
    ["done", "99"], ["delete", "99"], ["done", "1x"], ["done", "0"],
    ["delete", "-1"], ["done", "1", "extra"], ["stats", "--wat"],
  ];
  for (const args of invalid) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(original);
  }
});

test("malformed JSON and invalid database structures fail without replacing data", () => {
  const task = run(["add", "--title", "Keep"]);
  const invalid = ["{", "null", "[]", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, tags: ["Work"] }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2023-02-29" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, status: "done" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] })];
  for (const bytes of invalid) {
    writeFileSync(file, bytes);
    for (const args of [["list"], ["stats"], ["add", "--title", "Replace"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  }
});

test("default storage and write failures produce the expected JSON contract", () => {
  expect(run(["add", "--title", "Default"], true, true).id).toBe(1);
  expect(run(["list"], true, true)).toHaveLength(1);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
  file = join(directory, "missing-parent", "tasks.json");
  run(["add", "--title", "Cannot write"], false);
  expect(readdirSync(directory)).toEqual([".taskboard.json"]);
});
