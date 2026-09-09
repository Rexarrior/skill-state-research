import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve("src/cli.ts");
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(resolve(".test-taskboard-"));
  dirs.push(dir);
  const file = join(dir, "db.json");
  function run(args: string[], ok = true, custom = true, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    delete env.TASKBOARD_FILE;
    if (custom) env.TASKBOARD_FILE = file;
    const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    expect(result.exitCode === 0).toBe(ok);
    const output = result.stdout.toString().trim();
    expect(output.split("\n")).toHaveLength(1);
    const value = JSON.parse(output);
    if (ok) expect(result.stderr.toString()).toBe("");
    else { expect(value.error).toBeString(); expect(result.stderr.length).toBeGreaterThan(0); }
    return value;
  }
  return { dir, file, run };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("persistent lifecycle, normalized tags, filters, stable IDs and idempotency", () => {
  const { run, file, dir } = fixture();
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", " First ", "--tags", " Work,work, URGENT, ,", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  run(["add", "--title", "Second", "--due", "2024-03-01"]);
  run(["add", "--title", "Third"]);
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3]);
  expect(run(["list", "--status", "open", "--tag", "WORK", "--overdue", "2024-03-01"])).toEqual([first]);
  expect(run(["list", "--overdue", "2024-02-29"])).toEqual([]);
  const done = run(["done", "1"]);
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["list", "--status", "done", "--overdue", "2099-01-01"])).toEqual([]);
  expect(run(["list", "--status", "done"])).toEqual([done]);
  expect(run(["delete", "3"]).id).toBe(3);
  expect(run(["add", "--title", "Fourth"]).id).toBe(4);
  expect(readdirSync(dir)).toEqual(["db.json"]);
});

test("invalid arguments and missing tasks preserve the database", () => {
  const { run, file } = fixture();
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["add"], ["add", "--title", " "],
    ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"],
    ["add", "--title", "x", "--due", "2024-2-01"], ["add", "--title", "x", "--tags"],
    ["add", "--title", "x", "--title", "y"], ["list", "--bad", "x"], ["list", "--status", "bad"],
    ["list", "--overdue", "no"], ["list", "--tag", " "], ["stats", "--bad"],
    ["done", "99"], ["delete", "99"], ["done", "1x"], ["delete", "0"], ["done", "1", "2"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
});

test("malformed JSON and invalid schemas are never overwritten", () => {
  const { run, file } = fixture();
  for (const text of ["{broken", "null", "{}", '{"version":1,"nextId":1,"tasks":[{}]}']) {
    writeFileSync(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "No"], ["done", "1"], ["delete", "1"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
});

test("default path and stats use strict local-day overdue boundaries", () => {
  const { run, dir } = fixture();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "Old", "--due", "2000-01-01"], true, false);
  run(["add", "--title", "Today", "--due", today], true, false);
  run(["add", "--title", "Completed", "--due", "2000-01-01"], true, false);
  run(["done", "3"], true, false);
  expect(run(["stats"], true, false)).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
});
