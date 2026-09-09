import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

let directory: string;
let database: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "board.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, TASKBOARD_FILE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("taskboard CLI", () => {
  test("persists, normalizes, filters, completes, and deletes tasks", async () => {
    const first = await cli("add", "--title", "Pay bills", "--tags", "Home, URGENT,home", "--due", "2000-01-01");
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ id: 1, title: "Pay bills", status: "open", tags: ["home", "urgent"] });

    const second = await cli("add", "--title", "Read book", "--tags", "leisure");
    expect(JSON.parse(second.stdout).id).toBe(2);
    expect(JSON.parse((await cli("list", "--tag", "HOME")).stdout)).toHaveLength(1);
    expect(JSON.parse((await cli("list", "--overdue", "2020-01-01")).stdout).map((task: { id: number }) => task.id)).toEqual([1]);

    const done = JSON.parse((await cli("done", "1")).stdout);
    const doneAgain = JSON.parse((await cli("done", "1")).stdout);
    expect(done.status).toBe("done");
    expect(doneAgain.completedAt).toBe(done.completedAt);
    expect(JSON.parse((await cli("stats")).stdout)).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });

    expect(JSON.parse((await cli("delete", "2")).stdout).id).toBe(2);
    const third = JSON.parse((await cli("add", "--title", "Stable id")).stdout);
    expect(third.id).toBe(3);
  });

  test("rejects invalid inputs and preserves malformed data", async () => {
    expect((await cli("add", "--title", " ")).exitCode).not.toBe(0);
    expect((await cli("add", "--title", "bad date", "--due", "2023-02-29")).exitCode).not.toBe(0);
    expect((await cli("list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await cli("delete", "999")).exitCode).not.toBe(0);

    await writeFile(database, "not json\n");
    const result = await cli("add", "--title", "Must not overwrite");
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(database).text()).toBe("not json\n");
  });
});
