import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];

async function sandbox(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  temporaryDirectories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

async function invoke(directory: string, database: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes, and keeps IDs stable", async () => {
    const { directory, database } = await sandbox();
    const first = await invoke(directory, database, [
      "add", "--title", " First task ", "--tags", " Work,urgent,work ", "--due", "2020-01-02",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"] });

    await invoke(directory, database, ["add", "--title", "Second", "--tags", "home"]);
    const filtered = await invoke(directory, database, ["list", "--status", "open", "--tag", "WORK", "--overdue", "2020-01-03"]);
    expect(filtered.value.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = await invoke(directory, database, ["done", "1"]);
    const completedAgain = await invoke(directory, database, ["done", "1"]);
    expect(completedAgain.value.completedAt).toBe(completed.value.completedAt);
    await invoke(directory, database, ["delete", "2"]);
    const third = await invoke(directory, database, ["add", "--title", "Third"]);
    expect(third.value.id).toBe(3);
  });

  test("reports stats and rejects invalid input without replacing the database", async () => {
    const { directory, database } = await sandbox();
    await invoke(directory, database, ["add", "--title", "Old", "--due", "2000-01-01"]);
    await invoke(directory, database, ["add", "--title", "Current"]);
    await invoke(directory, database, ["done", "2"]);
    const stats = await invoke(directory, database, ["stats"]);
    expect(stats.value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });

    const impossible = await invoke(directory, database, ["add", "--title", "Bad", "--due", "2023-02-29"]);
    expect(impossible.exitCode).not.toBe(0);
    expect(impossible.value.error).toContain("valid date");
    expect(impossible.stdout.trim().split("\n")).toHaveLength(1);

    await writeFile(database, "not json\n");
    const malformed = await invoke(directory, database, ["add", "--title", "Do not write"]);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.value).toEqual({ error: "Malformed taskboard database" });
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
