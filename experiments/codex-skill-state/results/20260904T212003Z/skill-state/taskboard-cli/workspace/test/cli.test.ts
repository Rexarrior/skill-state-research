import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

async function run(args: string[], file?: string) {
  const directory = file ? undefined : await mkdtemp(join(tmpdir(), "taskboard-test-"));
  if (directory) directories.push(directory);
  const database = file ?? join(directory!, "board.json");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { json: JSON.parse(stdout), stdout, stderr, exitCode, database };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and keeps ids stable", async () => {
    const first = await run(["add", "--title", " First ", "--tags", "Work, work, HOME", "--due", "2024-01-01"]);
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"] });

    const second = await run(["add", "--title", "Second", "--due", "2999-12-31"], first.database);
    expect(second.json.id).toBe(2);
    expect((await run(["list", "--tag", "WORK"], first.database)).json).toHaveLength(1);
    expect((await run(["list", "--overdue", "2024-01-02"], first.database)).json.map((task: any) => task.id)).toEqual([1]);

    const done = await run(["done", "1"], first.database);
    const completedAt = done.json.completedAt;
    expect(done.json.status).toBe("done");
    expect((await run(["done", "1"], first.database)).json.completedAt).toBe(completedAt);
    expect((await run(["stats"], first.database)).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect((await run(["delete", "1"], first.database)).json.id).toBe(1);
    expect((await run(["add", "--title", "Third"], first.database)).json.id).toBe(3);
  });

  test("rejects bad input without replacing malformed data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
    directories.push(directory);
    const database = join(directory, "board.json");
    await writeFile(database, "not json\n");
    const result = await run(["add", "--title", "Nope"], database);
    expect(result.exitCode).not.toBe(0);
    expect(result.json.error).toContain("Malformed");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toBe("");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });

  test("rejects impossible dates, unknown flags, and missing tasks", async () => {
    expect((await run(["add", "--title", "x", "--due", "2025-02-30"])).exitCode).not.toBe(0);
    expect((await run(["list", "--wat", "x"])).exitCode).not.toBe(0);
    expect((await run(["done", "99"])).exitCode).not.toBe(0);
  });
});
