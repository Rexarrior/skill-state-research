import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let directory: string;
let database: string;

async function invoke(...args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
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
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode, json: JSON.parse(stdout) };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "board.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("adds, normalizes, persists, lists and preserves monotonic ids", async () => {
    const first = await invoke("add", "--title", "  Ship it  ", "--tags", "Work, work, URGENT", "--due", "2099-12-31");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "Ship it", status: "open", tags: ["work", "urgent"], due: "2099-12-31" });
    expect(await invoke("delete", "1")).toMatchObject({ exitCode: 0 });
    expect((await invoke("add", "--title", "Next")).json.id).toBe(2);
    expect((await invoke("list", "--status", "open", "--tag", "WORK")).json).toEqual([]);
    expect(JSON.parse(await readFile(database, "utf8"))).toMatchObject({ version: 1, nextId: 3 });
  });

  test("combines filters and makes done idempotent", async () => {
    await invoke("add", "--title", "Old", "--tags", "x", "--due", "2020-01-01");
    await invoke("add", "--title", "Future", "--tags", "x", "--due", "2099-01-01");
    expect((await invoke("list", "--status", "open", "--tag", "X", "--overdue", "2021-01-01")).json.map((task: { id: number }) => task.id)).toEqual([1]);
    const completedAt = (await invoke("done", "1")).json.completedAt;
    expect((await invoke("done", "1")).json.completedAt).toBe(completedAt);
    expect((await invoke("stats")).json).toEqual({ total: 2, open: 1, done: 1, overdue: 0 });
  });

  test("rejects bad input and malformed data without replacing it", async () => {
    expect(await invoke("add", "--title", "", "--due", "2023-02-29")).toMatchObject({ exitCode: 1 });
    expect(await invoke("wat")).toMatchObject({ exitCode: 1 });
    expect(await invoke("done", "99")).toMatchObject({ exitCode: 1 });
    const malformed = "not json\n";
    await writeFile(database, malformed);
    const result = await invoke("list");
    expect(result.exitCode).toBe(1);
    expect(result.json.error).toContain("malformed");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });
});
