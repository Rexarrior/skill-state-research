import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const project = join(import.meta.dir, "..");
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  directories.push(directory);
  return directory;
}

async function run(directory: string, ...args: string[]) {
  const child = Bun.spawn(["bun", "run", join(project, "src/cli.ts"), ...args], {
    cwd: directory,
    env: { ...process.env, TASKBOARD_FILE: join(directory, "tasks.json") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr, json: JSON.parse(stdout) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and uses monotonic IDs", async () => {
    const directory = await temporaryDirectory();
    const first = await run(directory, "add", "--title", " First task ", "--tags", " Work,work, Urgent ", "--due", "2020-02-29");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "urgent"], due: "2020-02-29" });
    expect(new Date(first.json.createdAt).toISOString()).toBe(first.json.createdAt);

    await run(directory, "add", "--title", "Second", "--tags", "home");
    const matching = await run(directory, "list", "--status", "open", "--tag", "WORK", "--overdue", "2020-03-01");
    expect(matching.json.map((task: { id: number }) => task.id)).toEqual([1]);

    await run(directory, "delete", "1");
    const third = await run(directory, "add", "--title", "Third");
    expect(third.json.id).toBe(3);
  });

  test("done is idempotent and stats describe persisted state", async () => {
    const directory = await temporaryDirectory();
    await run(directory, "add", "--title", "Old", "--due", "2000-01-01");
    await run(directory, "add", "--title", "Finish me");
    const done = await run(directory, "done", "2");
    const repeated = await run(directory, "done", "2");
    expect(done.json.completedAt).toBe(repeated.json.completedAt);
    expect((await run(directory, "stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("rejects invalid input without replacing a malformed database", async () => {
    const directory = await temporaryDirectory();
    expect((await run(directory, "add", "--title", "x", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await run(directory, "list", "--wat", "x")).exitCode).not.toBe(0);

    const path = join(directory, "tasks.json");
    await writeFile(path, "not json\n");
    const result = await run(directory, "add", "--title", "safe");
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("not json\n");
  });
});
