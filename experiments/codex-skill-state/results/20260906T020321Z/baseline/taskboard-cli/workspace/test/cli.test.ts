import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface Invocation {
  exitCode: number;
  stdout: unknown;
  stderr: string;
}

let directory: string;
let databaseFile: string;

async function invoke(...args: string[]): Promise<Invocation> {
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
  return { exitCode, stdout: JSON.parse(stdout), stderr };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  databaseFile = join(directory, "tasks.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("adds, normalizes, persists, filters, and completes tasks", async () => {
    const first = await invoke("add", "--title", " Ship it ", "--tags", " Work,work, Urgent ", "--due", "2020-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2020-01-01" });

    const second = await invoke("add", "--title", "Later", "--tags", "home");
    expect(second.stdout).toMatchObject({ id: 2 });

    const filtered = await invoke("list", "--tag", "WORK", "--status", "open", "--overdue", "2020-01-02");
    expect(filtered.stdout).toEqual([first.stdout]);

    const completed = await invoke("done", "1");
    expect(completed.stdout).toMatchObject({ id: 1, status: "done" });
    expect((completed.stdout as { completedAt: string }).completedAt).toBeString();

    const repeated = await invoke("done", "1");
    expect(repeated.stdout).toEqual(completed.stdout);

    const stats = await invoke("stats");
    expect(stats.stdout).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("deletes without reusing IDs", async () => {
    await invoke("add", "--title", "One");
    expect((await invoke("delete", "1")).stdout).toMatchObject({ id: 1 });
    expect((await invoke("add", "--title", "Two")).stdout).toMatchObject({ id: 2 });
    expect((await invoke("list")).stdout).toEqual([
      expect.objectContaining({ id: 2, title: "Two" }),
    ]);
  });

  test("rejects bad input and preserves a malformed database", async () => {
    expect((await invoke("add", "--title", "", "--due", "2024-02-30")).exitCode).toBe(1);
    expect((await invoke("list", "--wat", "yes")).exitCode).toBe(1);

    await writeFile(databaseFile, "not-json\n");
    const malformed = await invoke("add", "--title", "Must not overwrite");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("Malformed database");
    expect(await readFile(databaseFile, "utf8")).toBe("not-json\n");
  });

  test("rejects impossible dates and missing tasks", async () => {
    expect((await invoke("add", "--title", "Bad date", "--due", "2023-02-29")).exitCode).toBe(1);
    expect((await invoke("done", "99")).exitCode).toBe(1);
    expect((await invoke("delete", "99")).exitCode).toBe(1);
  });
});

