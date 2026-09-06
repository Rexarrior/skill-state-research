import { afterEach, expect, test } from "bun:test";

const file = `/tmp/taskboard-cli-test-${process.pid}.json`;
const run = async (...args: string[]) => Bun.$`TASKBOARD_FILE=${file} bun run src/cli.ts ${args}`.quiet();

afterEach(async () => { await Bun.file(file).delete().catch(() => {}); });

test("persists, filters, completes, and deletes tasks", async () => {
  const added = JSON.parse((await run("add", "--title", " First task ", "--tags", "Work,work, Urgent", "--due", "2026-01-01")).text());
  expect(added).toMatchObject({ id: 1, title: "First task", tags: ["work", "urgent"], status: "open", due: "2026-01-01" });
  expect(JSON.parse((await run("list", "--tag", "WORK", "--overdue", "2026-02-01")).text())).toHaveLength(1);
  expect(JSON.parse((await run("done", "1")).text()).status).toBe("done");
  expect(JSON.parse((await run("stats")).text())).toMatchObject({ total: 1, open: 0, done: 1, overdue: 0 });
  expect(JSON.parse((await run("delete", "1")).text()).id).toBe(1);
});

test("rejects invalid input without replacing database", async () => {
  await run("add", "--title", "Kept");
  await expect(run("add", "--title", "", "--due", "2026-02-30")).rejects.toThrow();
  expect(JSON.parse((await run("list")).text())).toHaveLength(1);
});
