import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  temporaryDirectories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

function run(directory: string, database: string, ...arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", cli, ...arguments_],
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function json(result: ReturnType<typeof run>): unknown {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps ids stable", async () => {
    const { directory, database } = await workspace();
    const first = json(run(directory, database, "add", "--title", "  First task  ", "--tags", " Work,work, URGENT ", "--due", "2024-02-29")) as any;
    expect(first).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });

    const second = json(run(directory, database, "add", "--title", "Second", "--due", "2099-01-01")) as any;
    expect(second.id).toBe(2);
    expect(json(run(directory, database, "list", "--status", "open", "--tag", "WORK", "--overdue", "2024-03-01"))).toEqual([first]);

    const completed = json(run(directory, database, "done", "1")) as any;
    expect(completed.status).toBe("done");
    expect(typeof completed.completedAt).toBe("string");
    expect(json(run(directory, database, "done", "1"))).toEqual(completed);
    expect(json(run(directory, database, "delete", "2"))).toMatchObject({ id: 2 });
    expect((json(run(directory, database, "add", "--title", "Third")) as any).id).toBe(3);
    expect((json(run(directory, database, "add", "--title", "Late", "--due", "2000-01-01")) as any).id).toBe(4);

    const listed = json(run(directory, database, "list")) as any[];
    expect(listed.map((task) => task.id)).toEqual([1, 3, 4]);
    expect(json(run(directory, database, "stats"))).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("rejects bad input without creating or replacing data", async () => {
    const { directory, database } = await workspace();
    const impossible = run(directory, database, "add", "--title", "Bad", "--due", "2023-02-29");
    expect(impossible.exitCode).not.toBe(0);
    expect(impossible.stdout).toBe("");
    expect(impossible.stderr).toContain("invalid date");

    await writeFile(database, "{not-json\n");
    const before = await readFile(database, "utf8");
    const malformed = run(directory, database, "add", "--title", "Would overwrite");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("malformed taskboard database");
    expect(await readFile(database, "utf8")).toBe(before);
  });

  test("rejects unknown commands, flags, empty titles, and missing tasks", async () => {
    const { directory, database } = await workspace();
    for (const arguments_ of [
      ["wat"],
      ["list", "--wat", "x"],
      ["add", "--title", "   "],
      ["done", "1"],
      ["delete", "1"],
    ]) {
      const result = run(directory, database, ...arguments_);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr.startsWith("error: ")).toBe(true);
    }
  });
});
