import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let databaseFile: string;

async function cli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, TASKBOARD_FILE: databaseFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr, json: JSON.parse(stdout) };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  databaseFile = join(directory, "board.json");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and keeps IDs stable", async () => {
    const first = await cli("add", "--title", "  First task  ", "--tags", "Work, work, Urgent", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2000-01-01" });

    const second = await cli("add", "--title", "Second", "--tags", "home");
    expect(second.json.id).toBe(2);
    expect((await cli("list", "--tag", "WORK", "--status", "open")).json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect((await cli("list", "--overdue", "2000-01-02")).json.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = await cli("done", "1");
    expect(done.json.status).toBe("done");
    const repeated = await cli("done", "1");
    expect(repeated.json.completedAt).toBe(done.json.completedAt);
    expect((await cli("stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await cli("delete", "2")).json.id).toBe(2);
    expect((await cli("add", "--title", "Third")).json.id).toBe(3);
  });

  test("rejects invalid input and preserves malformed data", async () => {
    expect((await cli("add", "--title", "", "--due", "2024-02-30")).exitCode).not.toBe(0);
    expect((await cli("wat")).exitCode).not.toBe(0);
    expect((await cli("list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await cli("done", "999")).exitCode).not.toBe(0);

    await writeFile(databaseFile, "not json\n");
    const malformed = await cli("list");
    expect(malformed.exitCode).not.toBe(0);
    expect(JSON.parse(malformed.stdout).error).toContain("Malformed database");
    expect(await readFile(databaseFile, "utf8")).toBe("not json\n");
  });
});
