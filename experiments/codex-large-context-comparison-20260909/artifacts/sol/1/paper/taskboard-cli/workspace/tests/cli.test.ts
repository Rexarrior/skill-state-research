import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectDirectory = resolve(import.meta.dir, "..");
const temporaryRoot = resolve(projectDirectory, ".tmp", "tests");
let testDirectory = "";
let databasePath = "";

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
  value: unknown;
}

async function cli(...args: string[]): Promise<Result> {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: projectDirectory,
    env: { ...Bun.env, TASKBOARD_FILE: databasePath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return { exitCode, stdout, stderr, value: JSON.parse(lines[0]) };
}

beforeEach(async () => {
  testDirectory = resolve(temporaryRoot, crypto.randomUUID());
  databasePath = resolve(testDirectory, "board.json");
  await mkdir(testDirectory, { recursive: true });
});

afterEach(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, and keeps ids stable", async () => {
    const first = await cli("add", "--title", "  Ship release  ", "--tags", "Work, urgent,WORK", "--due", "2030-02-28");
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.value).toMatchObject({
      id: 1,
      title: "Ship release",
      status: "open",
      tags: ["work", "urgent"],
      due: "2030-02-28",
    });

    const second = await cli("add", "--title", "Follow up");
    expect(second.value).toMatchObject({ id: 2, tags: [] });
    expect((await cli("delete", "1")).exitCode).toBe(0);
    expect(await cli("add", "--title", "Third")).toMatchObject({
      exitCode: 0,
      value: expect.objectContaining({ id: 3 }),
    });

    const listed = await cli("list");
    expect((listed.value as Array<{ id: number }>).map((task) => task.id)).toEqual([2, 3]);
  });

  test("combines list filters and applies strict overdue semantics", async () => {
    await cli("add", "--title", "Old work", "--tags", "Work", "--due", "2024-01-01");
    await cli("add", "--title", "Boundary", "--tags", "work", "--due", "2024-01-02");
    await cli("add", "--title", "Old home", "--tags", "home", "--due", "2023-12-31");
    await cli("done", "1");

    expect((await cli("list", "--status", "done", "--tag", "WORK")).value).toHaveLength(1);
    const overdue = await cli("list", "--status", "open", "--tag", "work", "--overdue", "2024-01-02");
    expect(overdue.value).toEqual([]);
    expect((await cli("list", "--overdue", "2024-01-02")).value).toEqual([
      expect.objectContaining({ id: 3 }),
    ]);
  });

  test("done is idempotent and stats reflect current state", async () => {
    await cli("add", "--title", "Past", "--due", "0001-01-01");
    await cli("add", "--title", "No due");
    const first = await cli("done", "2");
    const completedAt = (first.value as { completedAt: string }).completedAt;
    const second = await cli("done", "2");
    expect((second.value as { completedAt: string }).completedAt).toBe(completedAt);
    expect((await cli("stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects bad input and prints one JSON error value", async () => {
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "Bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await cli(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.trim()).not.toBe("");
      expect(result.value).toHaveProperty("error");
    }
  });

  test("does not replace a malformed database", async () => {
    const malformed = "{ definitely not json\n";
    await writeFile(databasePath, malformed);
    const result = await cli("add", "--title", "Must fail");
    expect(result.exitCode).not.toBe(0);
    expect(result.value).toEqual({ error: "database is malformed: invalid JSON" });
    expect(await readFile(databasePath, "utf8")).toBe(malformed);
  });
});
