import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve("src/cli.ts");
function fixture(run: (invoke: (args: string[], ok?: boolean) => any, file: string, dir: string) => void, defaultPath = false) {
  const dir = mkdtempSync(resolve(".taskboard-test-"));
  const file = join(dir, defaultPath ? ".taskboard.json" : "custom.json");
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (!defaultPath) env.TASKBOARD_FILE = file;
  try {
    run((args, ok = true) => {
      const result = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
      const stdout = result.stdout.toString();
      const value = JSON.parse(stdout);
      expect(stdout.trim().split("\n").length).toBe(1);
      expect(result.exitCode === 0).toBe(ok);
      expect(result.stderr.toString().length === 0).toBe(ok);
      if (!ok) expect(typeof value.error).toBe("string");
      return value;
    }, file, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("persistent lifecycle, normalization, filters, idempotence and monotonic IDs", () => fixture((run, file, dir) => {
  expect(run(["list"])).toEqual([]);
  const first = run(["add", "--title", "  One  ", "--tags", " Work,work, ,URGENT", "--due", "2024-02-29"]);
  expect(first).toMatchObject({ id: 1, title: "One", tags: ["work", "urgent"], status: "open", due: "2024-02-29" });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  run(["add", "--title", "Two", "--tags", "work", "--due", "2024-03-01"]);
  run(["add", "--title", "Three"]);
  expect(run(["list"]).map((t: any) => t.id)).toEqual([1, 2, 3]);
  expect(run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2024-03-01"]).map((t: any) => t.id)).toEqual([1]);
  const done = run(["done", "1"]);
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, "utf8");
  expect(run(["done", "1"])).toEqual(done);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(run(["list", "--status", "done", "--overdue", "2025-01-01"])).toEqual([]);
  expect(run(["list", "--status", "done"])).toEqual([done]);
  expect(run(["delete", "3"]).id).toBe(3);
  expect(run(["add", "--title", "Four"]).id).toBe(4);
  expect(readdirSync(dir)).toEqual(["custom.json"]);
}));
test("invalid commands and arguments preserve the database", () => fixture((run, file) => {
  run(["add", "--title", "Keep"]);
  const before = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["add"], ["add", "--title", " "], ["add", "--title", "x", "--due", "2025-02-29"], ["add", "--title", "x", "--due", "2024-04-31"], ["add", "--title", "x", "--due", "2024-2-01"], ["add", "--title", "x", "--title", "y"], ["list", "--status", "bad"], ["list", "--tag"], ["list", "--unknown", "x"], ["list", "--overdue", "bad"], ["stats", "extra"], ["done", "999"], ["delete", "999"], ["done", "1x"], ["delete", "0"], ["done", "1", "extra"]]) {
    run(args, false);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
}));
test("malformed JSON and invalid database records are never replaced", () => fixture((run, file) => {
  const task = run(["add", "--title", "Keep"]);
  const valid = JSON.parse(readFileSync(file, "utf8"));
  for (const text of ["{", "null", "[]", "{}", JSON.stringify({ ...valid, nextId: 1 }), JSON.stringify({ ...valid, tasks: [task, task] }), JSON.stringify({ ...valid, tasks: [{ ...task, due: "2025-02-29" }] }), JSON.stringify({ ...valid, tasks: [{ ...task, status: "done" }] })]) {
    writeFileSync(file, text);
    for (const args of [["list"], ["add", "--title", "new"], ["done", "1"], ["delete", "1"], ["stats"]]) {
      run(args, false);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
}));
test("default path and local-day stats exclude done tasks and today's due dates", () => fixture((run) => {
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  run(["add", "--title", "old", "--due", "2000-01-01"]);
  run(["add", "--title", "today", "--due", today]);
  run(["add", "--title", "done", "--due", "2000-01-01"]);
  run(["done", "3"]);
  run(["add", "--title", "undated"]);
  expect(run(["stats"])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
}, true));
