import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
let dir: string;
let file: string;
const cli = resolve("src/cli.ts");
beforeEach(async () => { dir = await mkdtemp(resolve(".test-taskboard-")); file = join(dir, "tasks.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function run(args: string[], ok = true, useDefault = false) {
  const env = { ...process.env, TASKBOARD_FILE: file };
  if (useDefault) delete env.TASKBOARD_FILE;
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
  expect(result.exitCode === 0).toBe(ok);
  const output = result.stdout.toString().trim();
  expect(output.split("\n")).toHaveLength(1);
  expect(result.stderr.toString().length === 0).toBe(ok);
  return JSON.parse(output);
}
test("persistent lifecycle, normalized tags, AND filters and stable IDs", async () => {
  const first = run(["add", "--title", " First ", "--tags", " Work,work,URGENT,, ", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  run(["add", "--title", "Second", "--due", "2024-03-01"]);
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2]);
  expect(run(["list", "--status", "open", "--tag", "WORK", "--overdue", "2024-03-01"])).toEqual([first]);
  expect(run(["list", "--overdue", "2024-02-29"])).toEqual([]);
  const done = run(["done", "1"]);
  expect(done.status).toBe("done");
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  expect(run(["done", "1"])).toEqual(done);
  expect(run(["list", "--status", "done", "--overdue", "2025-01-01"])).toEqual([]);
  expect(run(["delete", "2"]).id).toBe(2);
  expect(run(["add", "--title", "Third"]).id).toBe(3);
  expect((await readdir(dir)).sort()).toEqual(["tasks.json"]);
});
test("validation errors preserve database", async () => {
  run(["add", "--title", "Keep"]);
  const original = await readFile(file, "utf8");
  for (const args of [[], ["wat"], ["list", "--wat", "x"], ["add"], ["add", "--title", " "], ["add", "--title", "x", "--due", "2023-02-29"], ["add", "--title", "x", "--due", "2024-04-31"], ["add", "--title"], ["add", "--title", "x", "--title", "y"], ["list", "--status", "bad"], ["list", "--overdue", "2024-2-01"], ["done", "99"], ["delete", "99"], ["done", "1.0"], ["stats", "--wat"]]) {
    expect(run(args, false).error).toBeString();
    expect(await readFile(file, "utf8")).toBe(original);
  }
});
test("malformed JSON and schema are never overwritten", async () => {
  for (const text of ["{broken", "null", "{}", JSON.stringify({version: 1, nextId: 1, tasks: [{id: 1}]})]) {
    await writeFile(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "No"]]) {
      run(args, false);
      expect(await readFile(file, "utf8")).toBe(text);
    }
  }
});
test("default storage and local-date stats", () => {
  expect(run(["list"], true, true)).toEqual([]);
  run(["add", "--title", "Default"], true, true);
  expect(run(["list"], true, true)).toHaveLength(1);
  expect(run(["list"])).toEqual([]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  run(["add", "--title", "Old", "--due", "2000-01-01"]);
  run(["add", "--title", "Today", "--due", today]);
  run(["add", "--title", "Finished", "--due", "2000-01-01"]);
  run(["done", "3"]);
  expect(run(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
});
