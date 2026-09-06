import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let database: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
}

describe("taskboard CLI", () => {
  test("adds normalized tasks and persists across processes", async () => {
    const added = await cli("add", "--title", "  Ship it  ", "--tags", "Work, work, Urgent", "--due", "2099-12-31");
    expect(added.exitCode).toBe(0);
    expect(added.json).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2099-12-31" });
    expect(added.json.createdAt).toBeString();
    expect((await cli("list")).json).toEqual([added.json]);
    expect((await cli("add", "--title", "Second")).json.id).toBe(2);
  });

  test("filters with AND semantics and strict overdue dates", async () => {
    await cli("add", "--title", "Old", "--tags", "alpha", "--due", "2020-01-01");
    await cli("add", "--title", "Boundary", "--tags", "alpha", "--due", "2020-01-02");
    await cli("add", "--title", "Other", "--tags", "beta", "--due", "2020-01-01");
    expect((await cli("list", "--tag", "ALPHA", "--status", "open", "--overdue", "2020-01-02")).json.map((task: any) => task.id)).toEqual([1]);
  });

  test("done is idempotent, stats count correctly, and delete removes", async () => {
    await cli("add", "--title", "Old", "--due", "2000-01-01");
    await cli("add", "--title", "Open");
    const first = await cli("done", "1");
    const second = await cli("done", "1");
    expect(first.json.completedAt).toBe(second.json.completedAt);
    expect((await cli("stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect((await cli("delete", "1")).json.id).toBe(1);
    expect((await cli("list")).json.map((task: any) => task.id)).toEqual([2]);
  });

  test("rejects bad input without corrupting or replacing data", async () => {
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "Bad", "--due", "2023-02-29"],
      ["list", "--wat"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = await cli(...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(database, "not json\n");
    const malformed = await cli("add", "--title", "Must not replace");
    expect(malformed.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
