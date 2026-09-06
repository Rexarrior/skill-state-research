import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve(import.meta.dir, "../src/cli.ts");
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
  return { stdout, stderr, exitCode, value: JSON.parse(stdout) };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "taskboard-test-"));
  database = join(directory, "board.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("taskboard CLI", () => {
  test("persists tasks, normalizes tags, filters, and keeps IDs stable", async () => {
    const first = await invoke(
      "add",
      "--title",
      "  First task  ",
      "--tags",
      "Work, urgent,WORK",
      "--due",
      "2000-01-01",
    );
    expect(first.exitCode).toBe(0);
    expect(first.value).toMatchObject({
      id: 1,
      title: "  First task  ",
      status: "open",
      tags: ["work", "urgent"],
      due: "2000-01-01",
    });

    expect((await invoke("add", "--title", "Second task")).value.id).toBe(2);
    expect((await invoke("list", "--status", "open", "--tag", "WORK")).value).toHaveLength(1);
    expect((await invoke("list", "--overdue", "2000-01-02")).value.map((task: any) => task.id)).toEqual([1]);

    const completed = await invoke("done", "1");
    expect(completed.value.status).toBe("done");
    const completedAt = completed.value.completedAt;
    expect((await invoke("done", "1")).value.completedAt).toBe(completedAt);
    expect((await invoke("delete", "2")).value.id).toBe(2);
    expect((await invoke("add", "--title", "Third task")).value.id).toBe(3);
  });

  test("reports statistics and rejects impossible dates", async () => {
    expect((await invoke("add", "--title", "Bad", "--due", "2025-02-29")).exitCode).toBe(1);
    await invoke("add", "--title", "Old", "--due", "2000-01-01");
    await invoke("add", "--title", "Future", "--due", "2999-01-01");
    await invoke("done", "2");
    expect((await invoke("stats")).value).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  });

  test("does not replace a malformed database", async () => {
    const malformed = "{ definitely not json";
    await writeFile(database, malformed);
    const result = await invoke("add", "--title", "Nope");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Malformed");
    expect(result.value.error).toContain("Malformed");
    expect(await readFile(database, "utf8")).toBe(malformed);
  });

  test("rejects unknown input and missing tasks with one JSON output", async () => {
    for (const args of [
      ["unknown"],
      ["add", "--title", "x", "--wat", "y"],
      ["done", "99"],
    ]) {
      const result = await invoke(...args);
      expect(result.exitCode).toBe(1);
      expect(result.value).toHaveProperty("error");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});
