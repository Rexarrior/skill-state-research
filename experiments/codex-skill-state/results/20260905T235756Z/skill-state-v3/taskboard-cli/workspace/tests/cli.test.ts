import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const roots: string[] = [];

async function workspace(): Promise<{ root: string; database: string }> {
  const root = join(tmpdir(), `taskboard-test-${crypto.randomUUID()}`);
  await mkdir(root);
  roots.push(root);
  return { root, database: join(root, "tasks.json") };
}

function run(root: string, database: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: root,
    env: { ...process.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    json: JSON.parse(stdout),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, completes, and keeps IDs stable", async () => {
    const { root, database } = await workspace();
    const first = run(root, database, "add", "--title", " First task ", "--tags", "Work, work, HOME", "--due", "2020-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"], due: "2020-01-01" });

    expect(run(root, database, "add", "--title", "Second").json.id).toBe(2);
    expect(run(root, database, "list", "--tag", "WORK", "--status", "open").json.map((task: { id: number }) => task.id)).toEqual([1]);
    expect(run(root, database, "list", "--overdue", "2021-01-01").json.map((task: { id: number }) => task.id)).toEqual([1]);

    const done = run(root, database, "done", "1");
    expect(done.json.status).toBe("done");
    const completedAt = done.json.completedAt;
    expect(run(root, database, "done", "1").json.completedAt).toBe(completedAt);
    expect(run(root, database, "stats").json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect(run(root, database, "delete", "2").json.id).toBe(2);
    expect(run(root, database, "add", "--title", "Third").json.id).toBe(3);
  });

  test("rejects invalid input and always emits one JSON value", async () => {
    const { root, database } = await workspace();
    for (const args of [
      ["add", "--title", "   "],
      ["add", "--title", "bad date", "--due", "2023-02-29"],
      ["list", "--wat", "x"],
      ["done", "99"],
      ["unknown"],
    ]) {
      const result = run(root, database, ...args);
      expect(result.exitCode).not.toBe(0);
      expect(result.json.error).toBeString();
      expect(result.stdout.split("\n")).toHaveLength(1);
      expect(result.stderr).not.toBe("");
    }
  });

  test("does not overwrite a malformed database", async () => {
    const { root, database } = await workspace();
    const malformed = "{not json\n";
    await writeFile(database, malformed);
    const result = run(root, database, "add", "--title", "Nope");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
