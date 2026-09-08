import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
const cli = resolve(import.meta.dir, "../src/cli.ts");
function fixture(run: (dir: string, call: (...args: string[]) => any, file: string) => void) {
  const dir = mkdtempSync(resolve(import.meta.dir, ".taskboard-test-"));
  const file = join(dir, ".taskboard.json");
  const call = (...args: string[]) => {
    const env = { ...process.env }; delete env.TASKBOARD_FILE;
    const p = Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env });
    const stdout = p.stdout.toString().trim();
    expect(stdout.split("\n")).toHaveLength(1);
    return { value: JSON.parse(stdout), code: p.exitCode, stderr: p.stderr.toString() };
  };
  try { run(dir, call, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("persistent lifecycle, combined filters, monotonic IDs, idempotence and statistics", () => fixture((dir, call, file) => {
  expect(call("list").value).toEqual([]);
  const first = call("add", "--title", " First ", "--tags", " Work,work, URGENT,,", "--due", "2000-02-29");
  expect(first.code).toBe(0); expect(first.stderr).toBe("");
  expect(first.value).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"] });
  expect(Number.isFinite(Date.parse(first.value.createdAt))).toBe(true);
  expect(call("add", "--title", "Second", "--due", "9999-12-31").value.id).toBe(2);
  expect(call("list", "--tag", " WORK ", "--status", "open", "--overdue", "2000-03-01").value.map((t: any) => t.id)).toEqual([1]);
  expect(call("list", "--overdue", "2000-02-29").value).toEqual([]);
  expect(call("stats").value).toEqual({ total: 2, open: 2, done: 0, overdue: 1 });
  const done = call("done", "1").value;
  expect(Number.isFinite(Date.parse(done.completedAt))).toBe(true);
  const before = readFileSync(file, "utf8");
  expect(call("done", "1").value).toEqual(done); expect(readFileSync(file, "utf8")).toBe(before);
  expect(call("list", "--status", "done", "--overdue", "2020-01-01").value).toEqual([]);
  expect(call("stats").value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  expect(call("delete", "2").value.id).toBe(2);
  expect(call("add", "--title", "Third").value.id).toBe(3);
  expect(call("list").value.map((t: any) => t.id)).toEqual([1, 3]);
  expect(readdirSync(dir)).toEqual([".taskboard.json"]);
}));
test("invalid commands and input preserve database", () => fixture((_dir, call, file) => {
  call("add", "--title", "Keep"); const before = readFileSync(file, "utf8");
  for (const args of [[], ["wat"], ["list", "--wat", "x"], ["add"], ["add", "--title", " "], ["add", "--title"], ["add", "--title", "x", "--title", "y"], ["add", "--title", "x", "--due", "2025-02-29"], ["list", "--overdue", "2026-04-31"], ["list", "--status", "other"], ["stats", "extra"], ["done", "99"], ["delete", "99"], ["done", "1.0"], ["delete", "1", "extra"]]) {
    const result = call(...args); expect(result.code).not.toBe(0); expect(result.value.error).toBeString(); expect(result.stderr.length).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  }
}));
test("malformed storage never overwritten", () => fixture((_dir, call, file) => {
  for (const text of ["{", "null", "{}", JSON.stringify({ version: 1, nextId: 1, tasks: [{ id: 1 }] })]) {
    writeFileSync(file, text);
    for (const args of [["list"], ["stats"], ["add", "--title", "x"], ["done", "1"], ["delete", "1"]]) {
      expect(call(...args).code).not.toBe(0); expect(readFileSync(file, "utf8")).toBe(text);
    }
  }
}));
test("TASKBOARD_FILE selects separate persistent storage", () => fixture((dir, call) => {
  const custom = join(dir, "custom.json");
  const invoke = (...args: string[]) => Bun.spawnSync([process.execPath, "run", cli, ...args], { cwd: dir, env: { ...process.env, TASKBOARD_FILE: custom } });
  expect(invoke("add", "--title", "Custom").exitCode).toBe(0);
  expect(JSON.parse(invoke("list").stdout.toString())[0].title).toBe("Custom");
  expect(call("list").value).toEqual([]);
}));
