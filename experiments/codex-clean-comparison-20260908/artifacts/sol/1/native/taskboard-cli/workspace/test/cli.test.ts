import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace(): Promise<{ directory: string; database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return { directory, database: join(directory, "tasks.json") };
}

function invoke(directory: string, database: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    json: JSON.parse(result.stdout.toString()),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and preserves monotonic ids", async () => {
    const { directory, database } = await workspace();
    const first = invoke(directory, database, "add", "--title", " First task ", "--tags", "Work, work, Urgent", "--due", "2020-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2020-02-29" });

    const second = invoke(directory, database, "add", "--title", "Second", "--tags", "home");
    expect(second.json.id).toBe(2);
    expect(invoke(directory, database, "list", "--status", "open", "--tag", "WORK").json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect(invoke(directory, database, "list", "--overdue", "2020-03-01").json.map((task: { id: number }) => task.id)).toEqual([1]);

    const completed = invoke(directory, database, "done", "1").json;
    const repeated = invoke(directory, database, "done", "1").json;
    expect(completed.status).toBe("done");
    expect(repeated.completedAt).toBe(completed.completedAt);
    expect(invoke(directory, database, "delete", "2").json.id).toBe(2);
    expect(invoke(directory, database, "add", "--title", "Third").json.id).toBe(3);
    expect(invoke(directory, database, "stats").json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects bad input and does not replace a malformed database", async () => {
    const { directory, database } = await workspace();
    expect(invoke(directory, database, "add", "--title", "x", "--due", "2023-02-29").exitCode).not.toBe(0);
    expect(invoke(directory, database, "list", "--wat", "x").exitCode).not.toBe(0);

    const malformed = "{ definitely not json\n";
    await writeFile(database, malformed);
    const result = invoke(directory, database, "add", "--title", "safe");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not valid JSON");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
