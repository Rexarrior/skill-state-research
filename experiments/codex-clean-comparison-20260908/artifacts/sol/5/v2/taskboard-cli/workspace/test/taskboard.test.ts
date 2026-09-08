import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "taskboard-test-"));
const database = join(root, "board.json");
const cli = join(import.meta.dir, "..", "src", "cli.ts");

async function invoke(args: string[], expectedExit = 0) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...Bun.env, TASKBOARD_FILE: database, TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  const exit = await process.exited;
  if (exit !== expectedExit) throw new Error(`${args.join(" ")} exited ${exit}: ${stderr}`);
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1) throw new Error(`expected exactly one stdout line, got ${lines.length}`);
  return JSON.parse(lines[0]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const first = await invoke(["add", "--title", " First task ", "--tags", "Work, work,HOME", "--due", "2020-02-29"]);
  assert(first.id === 1 && first.title === "First task", "add should create task 1");
  assert(JSON.stringify(first.tags) === '["work","home"]', "tags should be normalized and unique");

  const second = await invoke(["add", "--title", "Second", "--due", "2999-01-01"]);
  assert(second.id === 2, "IDs should increase across processes");
  const filtered = await invoke(["list", "--status", "open", "--tag", "WORK", "--overdue", "2021-01-01"]);
  assert(filtered.length === 1 && filtered[0].id === 1, "list filters should combine");

  const done = await invoke(["done", "1"]);
  const doneAgain = await invoke(["done", "1"]);
  assert(done.status === "done" && done.completedAt === doneAgain.completedAt, "done should be idempotent");
  const stats = await invoke(["stats"]);
  assert(stats.total === 2 && stats.open === 1 && stats.done === 1 && stats.overdue === 0, "stats should be correct");

  await invoke(["delete", "1"]);
  const third = await invoke(["add", "--title", "Third"]);
  assert(third.id === 3, "deleted IDs must not be reused");

  await invoke(["add", "--title", "bad", "--due", "2023-02-29"], 1);
  await invoke(["list", "--wat", "x"], 1);
  await invoke(["done", "999"], 1);

  const before = await readFile(database, "utf8");
  await writeFile(database, "{broken", "utf8");
  await invoke(["add", "--title", "must not overwrite"], 1);
  assert((await readFile(database, "utf8")) === "{broken", "malformed data must not be replaced");
  await writeFile(database, before, "utf8");

  console.log("self-test: all checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
