import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
const cli = resolve(import.meta.dir, "../src/cli.ts");
function fixture(run: (f: { dir: string; file: string; invoke: (args: string[], ok?: boolean, defaultFile?: boolean) => any }) => void) {
  const dir = mkdtempSync(resolve(import.meta.dir, "../.test-"));
  const file = join(dir, "tasks.json");
  const invoke = (args: string[], ok = true, defaultFile = false) => {
    const env = { ...process.env };
    delete env.TASKBOARD_FILE;
    if (!defaultFile) env.TASKBOARD_FILE = file;
    const p = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    const stdout = p.stdout.toString().trim();
    expect(stdout.split("\n").length).toBe(1);
    const value = JSON.parse(stdout);
    expect(p.exitCode === 0).toBe(ok);
    if (ok) expect(p.stderr.toString()).toBe("");
    else { expect(p.stderr.toString().length).toBeGreaterThan(0); expect(typeof value.error).toBe("string"); }
    return value;
  };
  try { run({ dir, file, invoke }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("persistent lifecycle, normalization, combined filters, completion and monotonic IDs", () => fixture(({ file, dir, invoke }) => {
  expect(invoke(["list"])).toEqual([]);
  const a = invoke(["add", "--title", " A ", "--tags", "Work, work, URGENT,,", "--due", "2024-02-29"]);
  expect(a).toMatchObject({ id: 1, title: "A", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
  invoke(["add", "--title", "B", "--tags", "work", "--due", "2024-03-01"]);
  invoke(["add", "--title", "C"]);
  expect(invoke(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-03-01"]).map((t: any) => t.id)).toEqual([1]);
  const done = invoke(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, "utf8");
  expect(invoke(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(invoke(["list", "--status", "done", "--overdue", "2025-01-01"])).toEqual([]);
  expect(invoke(["delete", "3"]).id).toBe(3);
  expect(invoke(["add", "--title", "D"]).id).toBe(4);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.tasks.reverse(); writeFileSync(file, JSON.stringify(db));
  expect(invoke(["list"]).map((t: any) => t.id)).toEqual([1, 2, 4]);
  expect(readdirSync(dir)).toEqual(["tasks.json"]);
}));
test("invalid commands and dates preserve database", () => fixture(({ file, invoke }) => {
  invoke(["add", "--title", "safe"]);
  const before = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["list", "--wat", "x"], ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "x", "--title", "y"], ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"], ["list", "--overdue", "2024-2-01"], ["list", "--status", "bad"], ["list", "--tag", " "], ["done", "1x"], ["done", "0"], ["done", "999"], ["delete", "999"], ["delete", "1", "extra"], ["stats", "--foo"]]) {
    invoke(args, false); expect(readFileSync(file, "utf8")).toBe(before);
  }
}));
test("malformed JSON and invalid database records are never overwritten", () => fixture(({ file, invoke }) => {
  const task = invoke(["add", "--title", "safe"]);
  const base = { version: 1, nextId: 2, tasks: [task] };
  for (const value of ["{", "null", "[]", "{}", JSON.stringify({ ...base, nextId: 1 }), JSON.stringify({ ...base, tasks: [task, task] }), ...[{ tags: ["UPPER"] }, { due: "2024-02-30" }, { status: "done" }, { createdAt: "oops" }, { completedAt: "oops" }].map(change => JSON.stringify({ ...base, tasks: [{ ...task, ...change }] }))]) {
    writeFileSync(file, value);
    for (const args of [["list"], ["add", "--title", "new"], ["done", "1"], ["delete", "1"], ["stats"]]) {
      invoke(args, false); expect(readFileSync(file, "utf8")).toBe(value);
    }
  }
}));
test("stats uses local date, excludes completed and undated tasks; default storage works", () => fixture(({ dir, invoke }) => {
  const now = new Date();
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  invoke(["add", "--title", "past", "--due", day(yesterday)]);
  invoke(["add", "--title", "today", "--due", day(now)]);
  invoke(["add", "--title", "completed", "--due", day(yesterday)]);
  invoke(["done", "3"]);
  invoke(["add", "--title", "undated"]);
  expect(invoke(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
  expect(invoke(["list"], true, true)).toEqual([]);
  invoke(["add", "--title", "default"], true, true);
  expect(JSON.parse(readFileSync(join(dir, ".taskboard.json"), "utf8")).tasks[0].title).toBe("default");
}));
