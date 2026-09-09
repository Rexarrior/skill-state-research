import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../src/cli.ts");
let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(join(resolve(import.meta.dir, ".."), ".taskboard-test-"));
  file = join(directory, "tasks.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(args: string[], success = true, defaultFile = false) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (!defaultFile) env.TASKBOARD_FILE = file;
  const child = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: directory, env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const result = JSON.parse(stdout); // Rejects extra JSON values or non-JSON output.
  if (success) {
    expect(code).toBe(0);
    expect(stderr).toBe("");
  } else {
    expect(code).not.toBe(0);
    expect(stderr.trim().length).toBeGreaterThan(0);
    expect(typeof result.error).toBe("string");
  }
  return result;
}

describe("Taskboard CLI", () => {
  test("persists tasks, normalizes tags, completes idempotently and never reuses IDs", async () => {
    expect(await run(["list"])).toEqual([]);
    const first = await run(["add", "--title", "  First  ", "--tags", " Work,work, URGENT,, ", "--due", "2024-02-29"]);
    expect(first).toMatchObject({ id: 1, title: "First", status: "open", tags: ["work", "urgent"], due: "2024-02-29" });
    expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
    expect(first.completedAt).toBeUndefined();
    const second = await run(["add", "--title", "Second"]);
    expect(second.id).toBe(2);
    expect(second.tags).toEqual([]);
    expect(second.due).toBeUndefined();
    expect(await run(["list"])).toEqual([first, second]);
    const done = await run(["done", "1"]);
    expect(done.status).toBe("done");
    expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
    const bytes = await readFile(file, "utf8");
    expect(await run(["done", "1"])).toEqual(done);
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect(await run(["delete", "2"])).toEqual(second);
    expect((await run(["add", "--title", "Third"])).id).toBe(3);
    expect((await run(["list"])).map((task: any) => task.id)).toEqual([1, 3]);
    expect(await readdir(directory)).toEqual(["tasks.json"]);
  });

  test("combines filters, excludes completed and boundary dates from overdue, sorts by ID", async () => {
    await run(["add", "--title", "Old", "--tags", "work", "--due", "2020-01-01"]);
    await run(["add", "--title", "Boundary", "--tags", "work", "--due", "2020-01-02"]);
    await run(["add", "--title", "Other", "--tags", "home", "--due", "2019-01-01"]);
    await run(["add", "--title", "Done", "--tags", "work", "--due", "2019-01-01"]);
    await run(["add", "--title", "No due", "--tags", "work"]);
    await run(["done", "4"]);
    const db = JSON.parse(await readFile(file, "utf8"));
    db.tasks.reverse();
    await writeFile(file, JSON.stringify(db));
    expect((await run(["list"])).map((t: any) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect((await run(["list", "--status", "open", "--tag", " WORK ", "--overdue", "2020-01-02"])).map((t: any) => t.id)).toEqual([1]);
    expect((await run(["list", "--overdue", "2020-01-02"])).map((t: any) => t.id)).toEqual([1, 3]);
    expect(await run(["list", "--status", "done", "--overdue", "2020-01-02"])).toEqual([]);
    expect((await run(["list", "--status", "done"])).map((t: any) => t.id)).toEqual([4]);
  });

  test("stats uses the local date and strictly excludes today", async () => {
    expect(await run(["stats"])).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await run(["add", "--title", "Old", "--due", "2000-01-01"]);
    await run(["add", "--title", "Today", "--due", today]);
    await run(["add", "--title", "Done", "--due", "2000-01-01"]);
    await run(["done", "3"]);
    expect(await run(["stats"])).toEqual({ total: 3, open: 2, done: 1, overdue: 1 });
  });

  test("invalid commands and values fail without changing the database", async () => {
    await run(["add", "--title", "Keep"]);
    const original = await readFile(file, "utf8");
    const invalid = [
      [], ["unknown"], ["add"], ["add", "--title", "  "], ["add", "--title"],
      ["add", "--title", "x", "--bad", "y"], ["add", "--title", "x", "--title", "y"],
      ["add", "--title", "x", "--due", "2023-02-29"],
      ["add", "--title", "x", "--due", "2024-04-31"],
      ["add", "--title", "x", "--due", "2024-13-01"],
      ["add", "--title", "x", "--due", "2024-2-01"],
      ["list", "--status", "other"], ["list", "--tag", " "],
      ["list", "--overdue", "2023-02-29"], ["list", "--tag"], ["list", "--wat", "x"],
      ["done"], ["done", "1", "2"], ["done", "1.5"], ["done", "0"],
      ["done", "9007199254740993"], ["done", "999"], ["delete", "999"],
      ["delete", "1", "--force"], ["stats", "--extra"],
    ];
    for (const args of invalid) {
      await run(args, false);
      expect(await readFile(file, "utf8")).toBe(original);
    }
  });

  test("rejects malformed JSON and invalid schemas without replacing bytes", async () => {
    const task = await run(["add", "--title", "Valid"]);
    const malformed = [
      "", "{broken", "null", "[]", "{}",
      JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
      JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
      ...[
        { id: -1 }, { title: " " }, { tags: ["UPPER"] }, { tags: ["x", "x"] },
        { status: "unknown" }, { status: "done" }, { createdAt: "yesterday" },
        { due: "2023-02-29" }, { completedAt: task.createdAt },
      ].map(patch => JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...patch }] })),
    ];
    for (const raw of malformed) {
      await writeFile(file, raw);
      await run(["list"], false);
      await run(["add", "--title", "Do not overwrite"], false);
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });

  test("uses the default path and reports write errors without leaving temporary files", async () => {
    const task = await run(["add", "--title", "Default"], true, true);
    expect(await run(["list"], true, true)).toEqual([task]);
    expect(await readdir(directory)).toEqual([".taskboard.json"]);
    file = join(directory, "missing", "tasks.json");
    await run(["add", "--title", "Cannot save"], false);
    expect(await readdir(directory)).toEqual([".taskboard.json"]);
  });
});
