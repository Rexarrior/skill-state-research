import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-"));
  directories.push(directory);
  const database = join(directory, "tasks.json");
  const invoke = async (...args: string[]) => {
    const process = Bun.spawn(["bun", "run", join(import.meta.dir, "cli.ts"), ...args], {
      cwd: directory,
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
  };
  return { database, invoke };
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps stable IDs", async () => {
    const { invoke } = await fixture();
    const first = await invoke("add", "--title", " First ", "--tags", "Work, work, HOME", "--due", "2020-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "home"] });
    expect((await invoke("list", "--tag", "WORK")).value).toHaveLength(1);
    expect((await invoke("list", "--overdue", "2020-01-02")).value).toHaveLength(1);
    expect((await invoke("delete", "1")).exitCode).toBe(0);
    expect((await invoke("add", "--title", "Second")).value.id).toBe(2);
  });

  test("done is idempotent and stats are correct", async () => {
    const { invoke } = await fixture();
    await invoke("add", "--title", "Old", "--due", "2000-01-01");
    await invoke("add", "--title", "New");
    const first = await invoke("done", "2");
    const second = await invoke("done", "2");
    expect(second.value.completedAt).toBe(first.value.completedAt);
    expect((await invoke("stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input without replacing malformed data", async () => {
    const { database, invoke } = await fixture();
    expect((await invoke("add", "--title", "x", "--due", "2023-02-29")).exitCode).toBe(1);
    expect((await invoke("wat")).value).toEqual({ error: "unknown command: wat" });
    await writeFile(database, "not json\n");
    const result = await invoke("list");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("malformed database");
    expect(await readFile(database, "utf8")).toBe("not json\n");
  });
});
