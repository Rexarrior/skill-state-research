import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  roots.push(root);
  return { root, file: join(root, "board.json") };
}

async function run(file: string, ...args: string[]) {
  const process = Bun.spawn([processExec(), "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode, json: JSON.parse(stdout) as unknown };
}

function processExec(): string {
  return Bun.which("bun") ?? "bun";
}

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const { file } = await workspace();
    const first = await run(file, "add", "--title", "First", "--tags", " Work,urgent,work ", "--due", "2024-01-01");
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-01-01" });

    expect((await run(file, "delete", "1")).exitCode).toBe(0);
    const second = await run(file, "add", "--title", "Second", "--tags", "WORK");
    expect(second.json).toMatchObject({ id: 2, tags: ["work"] });
    const listed = await run(file, "list", "--status", "open", "--tag", " Work ");
    expect(listed.json).toEqual([second.json]);
  });

  test("done is idempotent and stats count only open overdue tasks", async () => {
    const { file } = await workspace();
    await run(file, "add", "--title", "Old", "--due", "2000-01-01");
    await run(file, "add", "--title", "Future", "--due", "2999-01-01");
    const done = await run(file, "done", "1");
    const repeated = await run(file, "done", "1");
    expect(repeated.json).toEqual(done.json);
    expect(await run(file, "stats")).toMatchObject({ exitCode: 0, json: { total: 2, open: 1, done: 1, overdue: 0 } });
    expect((await run(file, "list", "--overdue", "3000-01-01")).json).toEqual([
      expect.objectContaining({ id: 2 }),
    ]);
  });

  test("rejects bad input and malformed storage without replacing it", async () => {
    const { file } = await workspace();
    const invalidDate = await run(file, "add", "--title", "Bad", "--due", "2023-02-29");
    expect(invalidDate.exitCode).not.toBe(0);
    expect(invalidDate.json).toBeNull();
    expect(invalidDate.stderr).toContain("valid YYYY-MM-DD");

    await writeFile(file, "not json\n");
    const malformed = await run(file, "list");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.json).toBeNull();
    expect(await readFile(file, "utf8")).toBe("not json\n");
  });

  test("rejects unknown commands and flags", async () => {
    const { file } = await workspace();
    expect((await run(file, "wat")).exitCode).not.toBe(0);
    expect((await run(file, "list", "--wat", "x")).exitCode).not.toBe(0);
    expect((await run(file, "done", "missing")).exitCode).not.toBe(0);
  });
});
