import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const directories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "taskboard-"));
  directories.push(directory);
  return { directory, file: join(directory, "board.json") };
}

async function run(file: string, ...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { value: JSON.parse(stdout), stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("taskboard CLI", () => {
  test("persists, filters, completes, deletes, and reports stats", async () => {
    const { file } = await workspace();
    const first = await run(file, "add", "--title", " First task ", "--tags", "Work, work,HOME", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({ id: 1, title: "First task", status: "open", tags: ["work", "home"] });
    expect((await run(file, "add", "--title", "Second")).value.id).toBe(2);
    expect((await run(file, "list", "--tag", "WORK", "--overdue", "2000-01-02")).value.map((task: any) => task.id)).toEqual([1]);
    const completed = await run(file, "done", "1");
    expect(completed.value.status).toBe("done");
    const repeated = await run(file, "done", "1");
    expect(repeated.value.completedAt).toBe(completed.value.completedAt);
    expect((await run(file, "stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
    expect((await run(file, "delete", "2")).value.id).toBe(2);
    expect((await run(file, "list")).value.map((task: any) => task.id)).toEqual([1]);
  });

  test("rejects invalid input and preserves malformed databases", async () => {
    const { file } = await workspace();
    const invalidDate = await run(file, "add", "--title", "x", "--due", "2025-02-29");
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.stdout.trim().split("\n")).toHaveLength(1);
    await writeFile(file, "not-json\n");
    const malformed = await run(file, "list");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("malformed");
    expect(await readFile(file, "utf8")).toBe("not-json\n");
  });

  test("rejects unknown flags, commands, and missing tasks", async () => {
    const { file } = await workspace();
    expect((await run(file, "add", "--title", "x", "--wat", "y")).exitCode).not.toBe(0);
    expect((await run(file, "unknown")).exitCode).not.toBe(0);
    expect((await run(file, "done", "99")).exitCode).not.toBe(0);
  });
});
