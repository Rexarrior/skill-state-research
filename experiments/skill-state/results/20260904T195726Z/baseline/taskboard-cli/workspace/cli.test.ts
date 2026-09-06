import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directories: string[] = [];

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(resolve(".taskboard-test-"));
  directories.push(directory);
  return resolve(directory, "tasks.json");
}

function cli(database: string, ...args: string[]): Result {
  const process = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = process.stdout.toString().trim();
  return {
    exitCode: process.exitCode,
    stdout,
    stderr: process.stderr.toString().trim(),
    json: JSON.parse(stdout),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and keeps IDs stable", async () => {
    const database = await fixture();
    const first = cli(database, "add", "--title", " First task ", "--tags", "Work, work,URGENT");
    const second = cli(database, "add", "--title", "Second task");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });
    expect(second.json).toMatchObject({ id: 2 });

    expect(cli(database, "delete", "1").exitCode).toBe(0);
    expect(cli(database, "add", "--title", "Third task").json).toMatchObject({ id: 3 });
    expect(cli(database, "list").json).toEqual([
      expect.objectContaining({ id: 2 }),
      expect.objectContaining({ id: 3 }),
    ]);

    const files = await readdir(resolve(database, ".."));
    expect(files).toEqual(["tasks.json"]);
  });

  test("combines list filters and completes idempotently", async () => {
    const database = await fixture();
    cli(database, "add", "--title", "Late", "--tags", "Work", "--due", "2025-01-01");
    cli(database, "add", "--title", "Current", "--tags", "work", "--due", "2025-02-01");
    cli(database, "add", "--title", "Other", "--tags", "home", "--due", "2025-01-01");

    expect(cli(database, "list", "--status", "open", "--tag", "WORK", "--overdue", "2025-01-02").json)
      .toEqual([expect.objectContaining({ id: 1 })]);

    const completed = cli(database, "done", "1").json as { completedAt: string };
    const repeated = cli(database, "done", "1").json as { completedAt: string };
    expect(repeated.completedAt).toBe(completed.completedAt);
    expect(cli(database, "list", "--overdue", "2025-01-02").json)
      .toEqual([expect.objectContaining({ id: 3 })]);
  });

  test("reports stats including only overdue open tasks", async () => {
    const database = await fixture();
    cli(database, "add", "--title", "Late", "--due", "2000-01-01");
    cli(database, "add", "--title", "Done late", "--due", "2000-01-01");
    cli(database, "add", "--title", "Future", "--due", "2999-01-01");
    cli(database, "done", "2");
    expect(cli(database, "stats").json).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });

  test("rejects invalid input with one JSON stdout value", async () => {
    const database = await fixture();
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "Bad date", "--due", "2025-02-29"],
      ["list", "--unknown", "value"],
      ["done", "9"],
      ["unknown"],
    ]) {
      const result = cli(database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toBe("");
      expect(result.json).toHaveProperty("error");
      expect(result.stdout.split("\n")).toHaveLength(1);
    }
  });

  test("does not replace a malformed database", async () => {
    const database = await fixture();
    const malformed = '{"version":1,"nextId":2,"tasks":[{"id":1,"createdAt":"invalid"}]}';
    await writeFile(database, malformed);
    const result = cli(database, "add", "--title", "Must not be written");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Malformed database");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
