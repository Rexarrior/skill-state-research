import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(import.meta.dir, ".taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

async function invoke(database: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists normalized tasks and filters them", async () => {
    const { database } = await workspace();
    const first = await invoke(database, "add", "--title", "  Ship it  ", "--tags", "Work, urgent,WORK", "--due", "2024-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });

    await invoke(database, "add", "--title", "Later", "--tags", "home", "--due", "2030-01-01");
    const filtered = await invoke(database, "list", "--status", "open", "--tag", "WORK", "--overdue", "2025-01-01");
    expect(filtered.value.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = await invoke(database, "done", "1");
    const completedAt = done.value.completedAt;
    expect(done.value.status).toBe("done");
    expect((await invoke(database, "done", "1")).value.completedAt).toBe(completedAt);
    expect((await invoke(database, "stats")).value).toMatchObject({ total: 2, open: 1, done: 1 });

    expect((await invoke(database, "delete", "1")).value.id).toBe(1);
    expect((await invoke(database, "add", "--title", "Third")).value.id).toBe(3);
    expect((await invoke(database, "list")).value.map((task: { id: number }) => task.id)).toEqual([2, 3]);
  });

  test("rejects invalid input without changing the database", async () => {
    const { database } = await workspace();
    await invoke(database, "add", "--title", "Valid");
    const before = await readFile(database, "utf8");
    const invalid = await invoke(database, "add", "--title", "No", "--due", "2023-02-29");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.value.error).toContain("valid date");
    expect(invalid.stderr).toContain("valid date");
    expect(await readFile(database, "utf8")).toBe(before);
  });

  test("does not replace a malformed database", async () => {
    const { database } = await workspace();
    await writeFile(database, "not json\n");
    const result = await invoke(database, "add", "--title", "Lost");
    expect(result.exitCode).not.toBe(0);
    expect(result.value).toEqual({ error: "malformed task database" });
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
