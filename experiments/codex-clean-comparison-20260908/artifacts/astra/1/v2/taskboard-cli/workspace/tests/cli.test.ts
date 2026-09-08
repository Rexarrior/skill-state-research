import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(custom = true) {
  const dir = mkdtempSync(resolve(".taskboard-test-")); dirs.push(dir);
  const file = join(dir, custom ? "custom.json" : ".taskboard.json");
  const env = { ...process.env }; delete env.TASKBOARD_FILE;
  if (custom) env.TASKBOARD_FILE = file;
  function run(args: string[], ok = true) {
    const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    const stdout = result.stdout.toString().trim();
    expect(stdout.split("\n")).toHaveLength(1);
    const value = JSON.parse(stdout);
    expect(result.exitCode === 0).toBe(ok);
    if (ok) expect(result.stderr.toString()).toBe("");
    else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(value.error).toBeString(); }
    return value;
  }
  return { dir, file, run };
}

test("persistent lifecycle, normalized tags, idempotence and non-reused IDs", () => {
  const { run, file, dir } = fixture();
  expect(run(["list"])).toEqual([]);
  const task = run(["add", "--title", "  First  ", "--tags", " Work,work, HOME, ,home", "--due", "2024-02-29"]);
  expect(task).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"], due: "2024-02-29" });
  expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
  expect(run(["list"])).toEqual([task]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(run(["delete", "1"])).toEqual(done);
  expect(run(["add", "--title", "Second"]).id).toBe(2);
  expect(readdirSync(dir)).toEqual(["custom.json"]);
});

test("AND filters, strict overdue boundaries, sorting and local stats", () => {
  const { run, file } = fixture(false);
  run(["add", "--title", "old", "--tags", "x", "--due", "2000-01-01"]);
  run(["add", "--title", "boundary", "--tags", "x", "--due", "2000-01-02"]);
  run(["add", "--title", "done", "--tags", "x", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "undated"]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  run(["add", "--title", "today", "--due", today]);
  const db = JSON.parse(readFileSync(file, "utf8")); db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1,2,3,4,5]);
  expect(run(["list", "--tag", " X ", "--status", "open", "--overdue", "2000-01-02"]).map((t: any) => t.id)).toEqual([1]);
  expect(run(["list", "--status", "done", "--overdue", today])).toEqual([]);
  expect(run(["stats"])).toEqual({ total: 5, open: 4, done: 1, overdue: 2 });
});

test("invalid commands and arguments fail without changing data", () => {
  const { run, file } = fixture();
  run(["add", "--title", "Keep"]);
  const original = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["stats", "--x"], ["list", "extra"], ["list", "--status", "bad"],
    ["list", "--overdue", "2023-02-29"], ["add"], ["add", "--title", " "], ["add", "--title"],
    ["add", "--title", "x", "--title", "y"], ["add", "--title", "x", "--unknown", "v"],
    ...["2023-02-29", "2024-04-31", "2024-13-01", "2024-00-01", "2024-1-01", "nope"].map(d => ["add", "--title", "x", "--due", d]),
    ["done", "999"], ["delete", "999"], ["done", "1.0"], ["done", "-1"], ["delete", "1", "extra"]]) {
    run(args, false); expect(readFileSync(file, "utf8")).toBe(original);
  }
});

test("malformed databases are preserved by all commands", () => {
  const { run, file } = fixture();
  const task = run(["add", "--title", "Keep"]);
  for (const data of ["{", "null", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: "2023-02-29" }] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, status: "done" }] })]) {
    writeFileSync(file, data);
    for (const args of [["list"], ["stats"], ["add", "--title", "x"], ["done", "1"], ["delete", "1"]]) {
      run(args, false); expect(readFileSync(file, "utf8")).toBe(data);
    }
  }
});
