import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let database: string;

interface Result {
  status: number;
  stdout: string;
  stderr: string;
  json: any;
}

function run(...args: string[]): Result {
  const result = Bun.spawnSync(["bun", "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return {
    status: result.exitCode,
    stdout,
    stderr: result.stderr.toString().trim(),
    json: JSON.parse(stdout),
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("taskboard CLI", () => {
  test("persists normalized tasks and keeps stable ids", () => {
    const first = run("add", "--title", "  First task  ", "--tags", "Work, work, HOME", "--due", "2099-02-28");
    const second = run("add", "--title", "Second");
    expect(first.status).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2099-02-28" });
    expect(new Date(first.json.createdAt).toISOString()).toBe(first.json.createdAt);
    expect(second.json.id).toBe(2);

    expect(run("delete", "1").json.id).toBe(1);
    expect(run("add", "--title", "Third").json.id).toBe(3);
    expect(run("list").json.map((task: any) => task.id)).toEqual([2, 3]);
  });

  test("combines list filters and uses strict overdue dates", () => {
    run("add", "--title", "Old", "--tags", "Urgent", "--due", "2020-01-01");
    run("add", "--title", "Boundary", "--tags", "urgent", "--due", "2020-01-02");
    run("add", "--title", "Other", "--tags", "misc", "--due", "2019-01-01");
    run("done", "1");

    expect(run("list", "--tag", "URGENT", "--status", "open").json.map((task: any) => task.id)).toEqual([2]);
    expect(run("list", "--overdue", "2020-01-02").json.map((task: any) => task.id)).toEqual([3]);
    expect(run("list", "--overdue", "2020-01-03", "--tag", "urgent").json.map((task: any) => task.id)).toEqual([2]);
  });

  test("done is idempotent and stats are accurate", () => {
    run("add", "--title", "Past", "--due", "2000-01-01");
    run("add", "--title", "Future", "--due", "2999-01-01");
    const first = run("done", "2").json;
    const second = run("done", "2").json;
    expect(second.completedAt).toBe(first.completedAt);
    expect(run("stats").json).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input without replacing malformed data", () => {
    expect(run("add", "--title", "x", "--due", "2023-02-29").status).toBe(1);
    expect(run("add", "--title", "   ").status).toBe(1);
    expect(run("list", "--wat", "x").status).toBe(1);
    expect(run("delete", "42").status).toBe(1);

    writeFileSync(database, "not json\n");
    const malformed = run("add", "--title", "do not write");
    expect(malformed.status).toBe(1);
    expect(readFileSync(database, "utf8")).toBe("not json\n");
  });

  test("uses the current directory default database", () => {
    const result = Bun.spawnSync(["bun", "run", cli, "add", "--title", "Local"], {
      cwd: directory,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "TASKBOARD_FILE")),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).id).toBe(1);
    expect(JSON.parse(readFileSync(join(directory, ".taskboard.json"), "utf8")).tasks).toHaveLength(1);
  });
});
