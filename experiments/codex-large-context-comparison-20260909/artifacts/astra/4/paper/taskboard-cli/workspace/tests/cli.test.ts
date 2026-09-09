import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(import.meta.dir, ".tmp-")); file = join(dir, "tasks.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(args: string[], ok = true, defaultFile = false) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (!defaultFile) env.TASKBOARD_FILE = file;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  expect(result.exitCode === 0).toBe(ok);
  const output = result.stdout.toString().trim();
  const value = JSON.parse(output);
  if (ok) expect(result.stderr.toString()).toBe("");
  else { expect(typeof value.error).toBe("string"); expect(result.stderr.toString().length).toBeGreaterThan(0); }
  return value;
}
test("persistent lifecycle, normalization, monotonic IDs and idempotent completion", () => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  First  ", "--tags", " Work,work, URGENT,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
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
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
});
test("AND filters, strict overdue boundaries, sorting and local-date stats", () => {
  run(["add", "--title", "Old", "--tags", "work", "--due", "2000-01-01"]);
  run(["add", "--title", "Boundary", "--tags", "work", "--due", "2000-01-02"]);
  run(["add", "--title", "No date", "--tags", "home"]);
  run(["add", "--title", "Finished", "--due", "2000-01-01"]);
  run(["done", "4"]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2000-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", "2000-01-02"])).toEqual([]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "Today", "--due", today]);
  expect(run(["stats"])).toEqual({ total: 5, open: 4, done: 1, overdue: 2 });
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
});
test("invalid inputs and missing tasks preserve bytes", () => {
  run(["add", "--title", "Keep"]);
  const bytes = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "X", "--due", "2023-02-29"], ["add", "--title", "X", "--due", "2024-04-31"],
    ["add", "--title", "X", "--title", "Y"], ["list", "--status", "bad"], ["list", "--wat", "x"],
    ["list", "--overdue", "2024-2-01"], ["list", "--tag", " "], ["stats", "extra"],
    ["done", "0"], ["done", "1.0"], ["done", "1", "extra"], ["done", "99"], ["delete", "99"]]) {
    run(args, false); expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});
test("malformed JSON and invalid database structures are never replaced", () => {
  for (const data of ["{", "null", "[]", "{}", '{"version":1,"nextId":1,"tasks":[{}]}']) {
    writeFileSync(file, data);
    for (const args of [["list"], ["stats"], ["add", "--title", "X"], ["done", "1"], ["delete", "1"]]) {
      run(args, false); expect(readFileSync(file, "utf8")).toBe(data);
    }
  }
});
test("default storage persists and write failures return JSON", () => {
  run(["add", "--title", "Default"], true, true);
  expect(run(["list"], true, true)[0].title).toBe("Default");
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
  file = join(dir, "missing", "tasks.json");
  run(["add", "--title", "Cannot save"], false);
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
});
